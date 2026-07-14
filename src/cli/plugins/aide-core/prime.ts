/**
 * Prime command - Outputs context for session start hook
 *
 * This command is designed to be called by Claude Code's SessionStart hook
 * to inject awareness of aide tooling into the agent's context.
 */

import { types as nodeUtilTypes } from 'node:util';

import { Cause, Effect } from 'effect';

import { defineAideCommand, textResult } from '@cli/host/command-descriptor.js';
import type {
  AideCommandDescriptor,
  CommandResult,
} from '@cli/host/command-descriptor.js';
import {
  AideInternalHostServicesTag,
  type AideInternalHostServices,
  type AidePrimeContributionRegistration,
} from '@cli/host/runtime-context.js';
import type {
  AidePluginAuthState,
  AidePluginAuthStatus,
  AidePrimeSection,
  AidePrimeStatusContribution,
  AidePrimeStatusMessages,
} from '@cli/host/plugin-descriptor.js';
import type { KeyringService } from '@lib/auth-keyring.js';
import { snapshotValidPrimeSections } from '@cli/host/prime-contribution.js';
import { invokePublicCapabilityEffect } from '@cli/host/public-capability-invocation.js';
import {
  defineHostArrayIndex,
  hostArrayIterable,
  ownArrayDataValue,
  ownArrayLength,
} from '@cli/host/host-owned-array.js';

type ConfigState = 'configured' | 'not-configured' | 'misconfigured';

type PrimeStatusFallbackReason =
  | 'returned a non-object status'
  | 'returned an unreadable status'
  | 'returned an invalid status state'
  | 'returned a non-string status detail'
  | 'returned an unsafe status detail'
  | 'status callback failed'
  | 'status callback returned an invalid Effect'
  | 'status Effect composition failed'
  | 'status Effect execution failed';

type PrimeStatusBoundaryFailureReason =
  | 'status callback failed'
  | 'status callback returned an invalid Effect'
  | 'status Effect composition failed'
  | 'status Effect execution failed';

interface PrimeStatusBoundaryFailure {
  readonly _tag: 'PrimeStatusBoundaryFailure';
  readonly reason: PrimeStatusBoundaryFailureReason;
}

const primeStatusBoundaryFailures = new WeakMap<
  object,
  PrimeStatusBoundaryFailureReason
>();

const isNodeProxy = nodeUtilTypes.isProxy;
const MAX_PRIME_STATUS_DETAIL_LENGTH = 1_024;
const primeStatusFormatCodePoint = /\p{Format}/u;

interface ResolvedPrimeStatus {
  readonly index: number;
  readonly contribution: Omit<AidePrimeStatusContribution<never>, 'status'>;
  readonly status: AidePluginAuthStatus;
}

interface PrimeStatusGroup {
  readonly id: string;
  readonly label: string;
  readonly state: ConfigState;
  readonly detail?: string;
}

function createPrimeStatusDetails(
  state?: ConfigState,
  detail?: string
): Partial<Record<ConfigState, string[]>> {
  const details = Object.create(null) as Partial<Record<ConfigState, string[]>>;
  if (state !== undefined && detail !== undefined) {
    Object.defineProperty(details, state, {
      configurable: true,
      enumerable: true,
      value: [detail],
      writable: true,
    });
  }
  return details;
}

function authStateToConfigState(state: AidePluginAuthState): ConfigState {
  if (state === 'configured') return 'configured';
  if (state === 'misconfigured') return 'misconfigured';
  return 'not-configured';
}

function aggregateConfigState(states: readonly ConfigState[]): ConfigState {
  let misconfigured = false;
  const stateCount = ownArrayLength(states) ?? 0;
  for (let index = 0; index < stateCount; index += 1) {
    const state = ownArrayDataValue<ConfigState>(states, index);
    if (!state.found) continue;
    if (state.value === 'configured') return 'configured';
    if (state.value === 'misconfigured') misconfigured = true;
  }
  if (misconfigured) return 'misconfigured';
  return 'not-configured';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function fallbackPluginStatus(
  pluginId: string,
  label: string,
  reason: PrimeStatusFallbackReason
): AidePluginAuthStatus {
  return Object.freeze({
    state: 'misconfigured',
    detail: `Plugin '${pluginId}' ${label} status is unavailable: ${reason}`,
  });
}

function isUnsafePrimeStatusCodePoint(
  codePoint: number,
  codePointText: string
): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    primeStatusFormatCodePoint.test(codePointText)
  );
}

function snapshotPrimeStatusDetail(value: string): string | undefined {
  const normalized = value.normalize('NFC');
  if (normalized.length > MAX_PRIME_STATUS_DETAIL_LENGTH) return undefined;
  for (const segment of normalized) {
    const codePoint = segment.codePointAt(0);
    if (
      codePoint === undefined ||
      isUnsafePrimeStatusCodePoint(codePoint, segment)
    ) {
      return undefined;
    }
  }
  return normalized;
}

function validatePrimeStatus<R>(
  pluginId: string,
  contribution: AidePrimeStatusContribution<R>,
  status: unknown
): AidePluginAuthStatus {
  if (!isRecord(status) || isNodeProxy(status)) {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned a non-object status'
    );
  }

  let state: unknown;
  let detail: unknown;
  try {
    state = status.state;
    detail = status.detail;
  } catch {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned an unreadable status'
    );
  }
  if (
    state !== 'configured' &&
    state !== 'not-configured' &&
    state !== 'misconfigured' &&
    state !== 'unavailable'
  ) {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned an invalid status state'
    );
  }

  if (detail !== undefined && typeof detail !== 'string') {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned a non-string status detail'
    );
  }

  const normalizedSafeDetail =
    typeof detail === 'string' ? snapshotPrimeStatusDetail(detail) : undefined;

  if (typeof detail === 'string' && normalizedSafeDetail === undefined) {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned an unsafe status detail'
    );
  }

  return Object.freeze({
    state,
    ...(detail === undefined ? {} : { detail: normalizedSafeDetail }),
  });
}

/**
 * Build configuration status section if any service is not configured.
 */
function buildConfigStatusSection(
  resolvedStatuses: readonly ResolvedPrimeStatus[]
): string {
  const statusesByGroup = new Map<
    string,
    {
      readonly label: string;
      readonly firstIndex: number;
      readonly states: ConfigState[];
      readonly messages: Partial<Record<ConfigState, string>>;
      readonly statusDetails: Partial<Record<ConfigState, string[]>>;
    }
  >();
  const groupIds: string[] = [];

  const resolvedStatusCount = ownArrayLength(resolvedStatuses) ?? 0;
  for (
    let statusIndex = 0;
    statusIndex < resolvedStatusCount;
    statusIndex += 1
  ) {
    const resolved = ownArrayDataValue<ResolvedPrimeStatus>(
      resolvedStatuses,
      statusIndex
    );
    if (!resolved.found) continue;
    const { index, contribution, status } = resolved.value;
    const state = authStateToConfigState(status.state);
    const existing = statusesByGroup.get(contribution.groupId);
    if (existing === undefined) {
      statusesByGroup.set(contribution.groupId, {
        label: contribution.groupLabel,
        firstIndex: index,
        states: [state],
        messages: primeMessagesByState(contribution.messages),
        statusDetails: createPrimeStatusDetails(state, status.detail),
      });
      const groupIndex = ownArrayLength(groupIds);
      if (groupIndex !== undefined) {
        defineHostArrayIndex(groupIds, groupIndex, contribution.groupId);
      }
      continue;
    }
    const stateIndex = ownArrayLength(existing.states);
    if (stateIndex !== undefined) {
      defineHostArrayIndex(existing.states, stateIndex, state);
    }
    mergePrimeMessages(existing.messages, contribution.messages);
    if (status.detail !== undefined) {
      const details = existing.statusDetails[state] ?? [];
      const detailIndex = ownArrayLength(details);
      if (detailIndex !== undefined) {
        defineHostArrayIndex(details, detailIndex, status.detail);
      }
      Object.defineProperty(existing.statusDetails, state, {
        configurable: true,
        enumerable: true,
        value: details,
        writable: true,
      });
    }
  }

  const groups: PrimeStatusGroup[] = [];
  let allConfigured = true;
  const groupCount = ownArrayLength(groupIds) ?? 0;
  for (let index = 0; index < groupCount; index += 1) {
    const idEntry = ownArrayDataValue<string>(groupIds, index);
    if (!idEntry.found) continue;
    const statusGroup = statusesByGroup.get(idEntry.value);
    if (statusGroup === undefined) continue;
    const state = aggregateConfigState(statusGroup.states);
    if (state !== 'configured') allConfigured = false;
    let fallbackDetail: string | undefined;
    const details = statusGroup.statusDetails[state];
    const detailCount = details === undefined ? 0 : ownArrayLength(details);
    if (detailCount !== undefined) {
      for (let detailIndex = 0; detailIndex < detailCount; detailIndex += 1) {
        const detail = ownArrayDataValue<string>(details!, detailIndex);
        if (detail.found && detail.value.trim() !== '') {
          fallbackDetail = detail.value;
          break;
        }
      }
    }
    defineHostArrayIndex(groups, index, {
      id: idEntry.value,
      label: statusGroup.label,
      state,
      detail:
        statusGroup.messages[state] ??
        (state === 'configured' ? undefined : fallbackDetail),
    });
  }

  if (allConfigured) {
    return '';
  }

  const lines: string[] = ['## Configuration Status', ''];

  const groupOutputCount = ownArrayLength(groups) ?? 0;
  for (let index = 0; index < groupOutputCount; index += 1) {
    const group = ownArrayDataValue<PrimeStatusGroup>(groups, index);
    if (!group.found) continue;
    const lineIndex = ownArrayLength(lines);
    if (lineIndex !== undefined) {
      defineHostArrayIndex(
        lines,
        lineIndex,
        formatConfigStatusLine(group.value)
      );
    }
  }

  const trailingIndex = ownArrayLength(lines);
  if (trailingIndex !== undefined)
    defineHostArrayIndex(lines, trailingIndex, '');
  let output = '';
  const lineCount = ownArrayLength(lines) ?? 0;
  for (let index = 0; index < lineCount; index += 1) {
    if (index > 0) output += '\n';
    const line = ownArrayDataValue<string>(lines, index);
    if (line.found) output += line.value;
  }
  return output;
}

function primeMessagesByState(
  messages: AidePrimeStatusMessages | undefined
): Partial<Record<ConfigState, string>> {
  const byState = Object.create(null) as Partial<Record<ConfigState, string>>;
  Object.defineProperties(byState, {
    configured: {
      configurable: true,
      enumerable: true,
      value: messages?.configured,
      writable: true,
    },
    'not-configured': {
      configurable: true,
      enumerable: true,
      value: messages?.notConfigured,
      writable: true,
    },
    misconfigured: {
      configurable: true,
      enumerable: true,
      value: messages?.misconfigured,
      writable: true,
    },
  });
  return byState;
}

function mergePrimeMessages(
  target: Partial<Record<ConfigState, string>>,
  source: AidePrimeStatusMessages | undefined
): void {
  const sourceByState = primeMessagesByState(source);
  target.configured ??= sourceByState.configured;
  target['not-configured'] ??= sourceByState['not-configured'];
  target.misconfigured ??= sourceByState.misconfigured;
}

function formatConfigStatusLine(group: PrimeStatusGroup): string {
  const detail = group.detail === undefined ? '' : ` (${group.detail})`;
  return `- ${group.label}: ${formatConfigState(group.state)}${detail}`;
}

function formatConfigState(state: ConfigState): string {
  if (state === 'configured') return 'Configured';
  if (state === 'misconfigured') return 'Misconfigured';
  return 'Not configured';
}

function primeStatusMetadata<R>(
  contribution: AidePrimeStatusContribution<R>
): Omit<AidePrimeStatusContribution<never>, 'status'> {
  return {
    groupId: contribution.groupId,
    groupLabel: contribution.groupLabel,
    label: contribution.label,
    messages: contribution.messages,
  };
}

function invokePrimeCallback<A, R>(
  callback: () => Effect.Effect<A, unknown, R>,
  name: string
): Effect.Effect<A, unknown, R> {
  return Effect.suspend(() => {
    try {
      const effect = callback();
      return Effect.isEffect(effect)
        ? effect
        : Effect.fail(new Error(`${name} must return an Effect`));
    } catch (error) {
      return Effect.fail(error);
    }
  });
}

function primeStatusBoundaryFailure(
  reason: PrimeStatusBoundaryFailureReason
): PrimeStatusBoundaryFailure {
  const failure = Object.freeze({
    _tag: 'PrimeStatusBoundaryFailure' as const,
    reason,
  });
  primeStatusBoundaryFailures.set(failure, reason);
  return failure;
}

function primeStatusBoundaryFailureReason(
  failure: unknown
): PrimeStatusBoundaryFailureReason {
  if (typeof failure !== 'object' || failure === null) {
    return 'status Effect execution failed';
  }
  return (
    primeStatusBoundaryFailures.get(failure) ?? 'status Effect execution failed'
  );
}

function resolvePrimeStatusEffect<R>(
  pluginId: string,
  contribution: AidePrimeStatusContribution<R>,
  index: number,
  effect: Effect.Effect<AidePluginAuthStatus, unknown, R>
): Effect.Effect<ResolvedPrimeStatus, unknown, R> {
  const metadata = primeStatusMetadata(contribution);
  const resolvedFallback = (
    reason: PrimeStatusFallbackReason
  ): ResolvedPrimeStatus => ({
    index,
    contribution: metadata,
    status: fallbackPluginStatus(pluginId, contribution.label, reason),
  });
  const resolvedStatus = (status: unknown): ResolvedPrimeStatus => ({
    index,
    contribution: metadata,
    status: validatePrimeStatus(pluginId, contribution, status),
  });

  return effect.pipe(
    Effect.map(resolvedStatus),
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed(resolvedFallback('status Effect execution failed'))
    )
  );
}

function resolveTrustedPrimeStatus(
  pluginId: string,
  contribution: AidePrimeStatusContribution<KeyringService>,
  index: number
): Effect.Effect<ResolvedPrimeStatus, unknown, KeyringService> {
  return Effect.suspend(() => {
    try {
      const effect = contribution.status();
      if (!Effect.isEffect(effect)) {
        return Effect.succeed({
          index,
          contribution: primeStatusMetadata(contribution),
          status: fallbackPluginStatus(
            pluginId,
            contribution.label,
            'status callback returned an invalid Effect'
          ),
        });
      }
      return resolvePrimeStatusEffect(pluginId, contribution, index, effect);
    } catch {
      return Effect.succeed({
        index,
        contribution: primeStatusMetadata(contribution),
        status: fallbackPluginStatus(
          pluginId,
          contribution.label,
          'status callback failed'
        ),
      });
    }
  });
}

function resolveExternalPrimeStatus(
  pluginId: string,
  contribution: AidePrimeStatusContribution<never>,
  index: number
): Effect.Effect<ResolvedPrimeStatus, unknown, never> {
  return invokePublicCapabilityEffect<
    AidePluginAuthStatus,
    unknown,
    ResolvedPrimeStatus,
    unknown,
    PrimeStatusBoundaryFailure
  >(
    contribution.status,
    {
      onCallbackThrow: () =>
        primeStatusBoundaryFailure('status callback failed'),
      onInvalidReturn: () =>
        primeStatusBoundaryFailure(
          'status callback returned an invalid Effect'
        ),
      onCompositionFailure: () =>
        primeStatusBoundaryFailure('status Effect composition failed'),
      onLaunchFailure: () =>
        primeStatusBoundaryFailure('status Effect execution failed'),
    },
    (effect) => resolvePrimeStatusEffect(pluginId, contribution, index, effect)
  ).pipe(
    Effect.catchAll((failure) =>
      Effect.succeed({
        index,
        contribution: primeStatusMetadata(contribution),
        status: fallbackPluginStatus(
          pluginId,
          contribution.label,
          primeStatusBoundaryFailureReason(failure)
        ),
      })
    )
  );
}

function sortPrimeSections(
  left: AidePrimeSection,
  right: AidePrimeSection
): number {
  const order = (left.order ?? 0) - (right.order ?? 0);
  if (order !== 0) return order;
  return left.id.localeCompare(right.id);
}

function resolvePrimeSections(
  registration: AidePrimeContributionRegistration
): Effect.Effect<readonly AidePrimeSection[], unknown, never> {
  const sections = registration.capability.sections;
  if (sections === undefined) return Effect.succeed([]);

  if (registration.provenance === 'external') {
    return invokePublicCapabilityEffect<
      readonly AidePrimeSection[],
      unknown,
      readonly AidePrimeSection[],
      unknown,
      PrimeStatusBoundaryFailure
    >(
      sections,
      {
        onCallbackThrow: () =>
          primeStatusBoundaryFailure('status callback failed'),
        onInvalidReturn: () =>
          primeStatusBoundaryFailure(
            'status callback returned an invalid Effect'
          ),
        onCompositionFailure: () =>
          primeStatusBoundaryFailure('status Effect composition failed'),
        onLaunchFailure: () =>
          primeStatusBoundaryFailure('status Effect execution failed'),
      },
      (effect) =>
        effect.pipe(
          Effect.map((result) =>
            snapshotValidPrimeSections(registration.pluginId, result)
          )
        )
    ).pipe(Effect.catchAll(() => Effect.succeed([])));
  }

  return invokePrimeCallback(sections, 'Prime sections callback').pipe(
    Effect.map((result) =>
      snapshotValidPrimeSections(registration.pluginId, result)
    ),
    Effect.catchAll(() => Effect.succeed([]))
  );
}

function collectPrimeData(services: AideInternalHostServices): Effect.Effect<
  Readonly<{
    readonly statuses: readonly ResolvedPrimeStatus[];
    readonly sections: readonly AidePrimeSection[];
  }>,
  unknown,
  never
> {
  const registrations = services.primeContributionRegistrations();
  const trustedStatuses: Effect.Effect<
    ResolvedPrimeStatus,
    unknown,
    KeyringService
  >[] = [];
  const externalStatuses: Effect.Effect<ResolvedPrimeStatus, unknown, never>[] =
    [];
  const trustedSections: Effect.Effect<
    readonly AidePrimeSection[],
    unknown,
    never
  >[] = [];
  const externalSections: Effect.Effect<
    readonly AidePrimeSection[],
    unknown,
    never
  >[] = [];
  let statusIndex = 0;
  const registrationCount = ownArrayLength(registrations) ?? 0;
  for (
    let registrationIndex = 0;
    registrationIndex < registrationCount;
    registrationIndex += 1
  ) {
    const registrationEntry =
      ownArrayDataValue<AidePrimeContributionRegistration>(
        registrations,
        registrationIndex
      );
    if (!registrationEntry.found) continue;
    const registration = registrationEntry.value;
    const contributions = registration.capability.status;
    const contributionCount =
      contributions === undefined ? 0 : ownArrayLength(contributions);
    if (registration.provenance === 'trusted') {
      if (contributionCount !== undefined) {
        for (let index = 0; index < contributionCount; index += 1) {
          const contribution = ownArrayDataValue<
            AidePrimeStatusContribution<KeyringService>
          >(contributions!, index);
          if (!contribution.found) continue;
          const effectIndex = ownArrayLength(trustedStatuses);
          if (effectIndex !== undefined) {
            defineHostArrayIndex(
              trustedStatuses,
              effectIndex,
              resolveTrustedPrimeStatus(
                registration.pluginId,
                contribution.value,
                statusIndex
              )
            );
          }
          statusIndex += 1;
        }
      }
      const sectionIndex = ownArrayLength(trustedSections);
      if (sectionIndex !== undefined) {
        defineHostArrayIndex(
          trustedSections,
          sectionIndex,
          resolvePrimeSections(registration)
        );
      }
    } else {
      if (contributionCount !== undefined) {
        for (let index = 0; index < contributionCount; index += 1) {
          const contribution = ownArrayDataValue<
            AidePrimeStatusContribution<never>
          >(contributions!, index);
          if (!contribution.found) continue;
          const effectIndex = ownArrayLength(externalStatuses);
          if (effectIndex !== undefined) {
            defineHostArrayIndex(
              externalStatuses,
              effectIndex,
              resolveExternalPrimeStatus(
                registration.pluginId,
                contribution.value,
                statusIndex
              )
            );
          }
          statusIndex += 1;
        }
      }
      const sectionIndex = ownArrayLength(externalSections);
      if (sectionIndex !== undefined) {
        defineHostArrayIndex(
          externalSections,
          sectionIndex,
          resolvePrimeSections(registration)
        );
      }
    }
  }

  const trustedStatusCount = ownArrayLength(trustedStatuses) ?? 0;
  const externalStatusCount = ownArrayLength(externalStatuses) ?? 0;
  const trustedStatusEffect =
    trustedStatusCount === 0
      ? Effect.succeed([])
      : services.provideTrustedKeyring(
          Effect.all(hostArrayIterable(trustedStatuses), {
            concurrency: trustedStatusCount,
          })
        );
  const externalStatusEffect = services.isolatePublicEffect(
    Effect.all(hostArrayIterable(externalStatuses), {
      concurrency: externalStatusCount || 1,
    })
  );
  const trustedSectionCount = ownArrayLength(trustedSections) ?? 0;
  const externalSectionCount = ownArrayLength(externalSections) ?? 0;
  const allSectionEffects: Effect.Effect<
    readonly AidePrimeSection[],
    unknown,
    never
  >[] = [];
  for (let index = 0; index < trustedSectionCount; index += 1) {
    const section = ownArrayDataValue<
      Effect.Effect<readonly AidePrimeSection[], unknown, never>
    >(trustedSections, index);
    if (section.found)
      defineHostArrayIndex(allSectionEffects, index, section.value);
  }
  for (let index = 0; index < externalSectionCount; index += 1) {
    const section = ownArrayDataValue<
      Effect.Effect<readonly AidePrimeSection[], unknown, never>
    >(externalSections, index);
    if (section.found) {
      const outputIndex = ownArrayLength(allSectionEffects);
      if (outputIndex !== undefined) {
        defineHostArrayIndex(allSectionEffects, outputIndex, section.value);
      }
    }
  }
  const sectionEffect = services.isolatePublicEffect(
    Effect.all(hostArrayIterable(allSectionEffects), {
      concurrency: trustedSectionCount + externalSectionCount || 1,
    })
  );

  return Effect.all(
    {
      trustedStatus: trustedStatusEffect,
      externalStatus: externalStatusEffect,
      sectionGroups: sectionEffect,
    },
    { concurrency: 3 }
  ).pipe(
    Effect.map(({ trustedStatus, externalStatus, sectionGroups }) => {
      const statusByIndex = new Map<number, ResolvedPrimeStatus>();
      const retainStatuses = (values: readonly ResolvedPrimeStatus[]): void => {
        const valueCount = ownArrayLength(values) ?? 0;
        for (let index = 0; index < valueCount; index += 1) {
          const value = ownArrayDataValue<ResolvedPrimeStatus>(values, index);
          if (value.found) statusByIndex.set(value.value.index, value.value);
        }
      };
      retainStatuses(trustedStatus);
      retainStatuses(externalStatus);
      const statuses: ResolvedPrimeStatus[] = [];
      for (let index = 0; index < statusIndex; index += 1) {
        const status = statusByIndex.get(index);
        if (status !== undefined) appendPrimeValue(statuses, status);
      }

      const unsortedSections: AidePrimeSection[] = [];
      const groupCount = ownArrayLength(sectionGroups) ?? 0;
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        const group = ownArrayDataValue<readonly AidePrimeSection[]>(
          sectionGroups,
          groupIndex
        );
        if (!group.found) continue;
        const sectionCount = ownArrayLength(group.value) ?? 0;
        for (let index = 0; index < sectionCount; index += 1) {
          const section = ownArrayDataValue<AidePrimeSection>(
            group.value,
            index
          );
          if (section.found) appendPrimeValue(unsortedSections, section.value);
        }
      }
      const sections: AidePrimeSection[] = [];
      const selected = new Set<number>();
      const sectionCount = ownArrayLength(unsortedSections) ?? 0;
      for (let outputIndex = 0; outputIndex < sectionCount; outputIndex += 1) {
        let selectedIndex: number | undefined;
        let selectedSection: AidePrimeSection | undefined;
        for (let index = 0; index < sectionCount; index += 1) {
          if (selected.has(index)) continue;
          const candidate = ownArrayDataValue<AidePrimeSection>(
            unsortedSections,
            index
          );
          if (!candidate.found) continue;
          if (
            selectedSection === undefined ||
            sortPrimeSections(candidate.value, selectedSection) < 0
          ) {
            selectedIndex = index;
            selectedSection = candidate.value;
          }
        }
        if (selectedIndex === undefined || selectedSection === undefined) break;
        selected.add(selectedIndex);
        defineHostArrayIndex(sections, outputIndex, selectedSection);
      }
      return Object.freeze({
        statuses: Object.freeze(statuses),
        sections: Object.freeze(sections),
      });
    })
  );
}

function appendPrimeValue<T>(target: T[], value: T): void {
  const index = ownArrayLength(target);
  if (index !== undefined) defineHostArrayIndex(target, index, value);
}

function formatPrimeOutput(
  configStatus: string,
  sections: readonly AidePrimeSection[]
): string {
  const parts = ['# aide - Jira & Git Hosting Integration', ''];

  if (configStatus) {
    appendPrimeValue(parts, configStatus);
  }

  appendPrimeValue(
    parts,
    'Use aide instead of az/gh/jira CLI tools. Auto-discovers org/project/repo from git remote.'
  );
  appendPrimeValue(parts, '');
  const sectionCount = ownArrayLength(sections) ?? 0;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = ownArrayDataValue<AidePrimeSection>(sections, index);
    if (!section.found) continue;
    appendPrimeValue(parts, section.value.body);
    appendPrimeValue(parts, '');
  }

  let output = '';
  const partCount = ownArrayLength(parts) ?? 0;
  for (let index = 0; index < partCount; index += 1) {
    if (index > 0) output += '\n';
    const part = ownArrayDataValue<string>(parts, index);
    if (part.found) output += part.value;
  }
  return output.trim();
}

export function buildPrimeOutputEffect(): Effect.Effect<
  string,
  unknown,
  AideInternalHostServicesTag
> {
  return Effect.gen(function* () {
    const services = yield* AideInternalHostServicesTag;
    const data = yield* collectPrimeData(services);

    return formatPrimeOutput(
      buildConfigStatusSection(data.statuses),
      data.sections
    );
  });
}

/**
 * @deprecated Live compatibility adapter. Trusted hosts should run
 * buildPrimeOutputEffect with host services created from their keyring layer.
 */
export async function buildPrimeOutput(opts: {
  readonly services: AideInternalHostServices;
}): Promise<string> {
  return Effect.runPromise(
    buildPrimeOutputEffect().pipe(
      Effect.provideService(AideInternalHostServicesTag, opts.services)
    )
  );
}

export function buildPrimeCommandEffect(): Effect.Effect<
  CommandResult,
  unknown,
  AideInternalHostServicesTag
> {
  return buildPrimeOutputEffect().pipe(Effect.map(textResult));
}

export function makePrimeCommandDescriptor(): AideCommandDescriptor<
  object,
  unknown,
  AideInternalHostServicesTag
> {
  return defineAideCommand.internalHost<object, unknown>({
    id: 'prime',
    route: 'prime',
    summary: 'Output aide context for session start hook',
    run: () => buildPrimeCommandEffect(),
  });
}

export const primeCommandDescriptor = makePrimeCommandDescriptor();
