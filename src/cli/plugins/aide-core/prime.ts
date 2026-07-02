/**
 * Prime command - Outputs context for session start hook
 *
 * This command is designed to be called by Claude Code's SessionStart hook
 * to inject awareness of aide tooling into the agent's context.
 */

import { Effect } from 'effect';

import { defineAideCommand, textResult } from '@cli/host/command-descriptor.js';
import type {
  AideCommandDescriptor,
  CommandResult,
} from '@cli/host/command-descriptor.js';
import {
  AideHostServicesTag,
  type AideHostServices,
} from '@cli/host/runtime-context.js';
import type {
  AidePluginAuthState,
  AidePluginAuthStatus,
  AidePrimeSection,
  AidePrimeStatusContribution,
  AidePrimeStatusMessages,
} from '@cli/host/plugin-descriptor.js';

type ConfigState = 'configured' | 'not-configured' | 'misconfigured';

interface ResolvedPrimeStatus {
  readonly index: number;
  readonly contribution: AidePrimeStatusContribution;
  readonly status: AidePluginAuthStatus;
}

interface PrimeStatusGroup {
  readonly id: string;
  readonly label: string;
  readonly state: ConfigState;
  readonly detail?: string;
}

function authStateToConfigState(state: AidePluginAuthState): ConfigState {
  if (state === 'configured') return 'configured';
  if (state === 'misconfigured') return 'misconfigured';
  return 'not-configured';
}

function aggregateConfigState(states: readonly ConfigState[]): ConfigState {
  if (states.includes('configured')) return 'configured';
  if (states.includes('misconfigured')) return 'misconfigured';
  return 'not-configured';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackPluginStatus(
  pluginId: string,
  label: string,
  reason: string
): AidePluginAuthStatus {
  return {
    state: 'misconfigured',
    detail: `Plugin '${pluginId}' ${label} status is unavailable: ${reason}`,
  };
}

function validatePrimeStatus(
  pluginId: string,
  contribution: AidePrimeStatusContribution,
  status: unknown
): AidePluginAuthStatus {
  if (!isRecord(status)) {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned a non-object status'
    );
  }

  const state = status.state;
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

  if (status.detail !== undefined && typeof status.detail !== 'string') {
    return fallbackPluginStatus(
      pluginId,
      contribution.label,
      'returned a non-string status detail'
    );
  }

  return Object.freeze({
    state,
    detail: status.detail,
  });
}

function validatePrimeSection(section: unknown): AidePrimeSection | null {
  if (!isRecord(section)) return null;
  if (typeof section.id !== 'string' || section.id.trim() === '') return null;
  if (typeof section.body !== 'string') return null;
  if (
    section.order !== undefined &&
    (typeof section.order !== 'number' || !Number.isFinite(section.order))
  ) {
    return null;
  }

  return Object.freeze({
    id: section.id,
    body: section.body,
    ...(section.order === undefined ? {} : { order: section.order }),
  });
}

function validatePrimeSections(sections: unknown): readonly AidePrimeSection[] {
  if (!Array.isArray(sections)) {
    return [];
  }

  return Object.freeze(
    sections.flatMap((section) => {
      const validated = validatePrimeSection(section);
      return validated === null ? [] : [validated];
    })
  );
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

  for (const { index, contribution, status } of resolvedStatuses) {
    const state = authStateToConfigState(status.state);
    const existing = statusesByGroup.get(contribution.groupId);
    if (existing === undefined) {
      statusesByGroup.set(contribution.groupId, {
        label: contribution.groupLabel,
        firstIndex: index,
        states: [state],
        messages: primeMessagesByState(contribution.messages),
        statusDetails:
          status.detail === undefined ? {} : { [state]: [status.detail] },
      });
      continue;
    }
    existing.states.push(state);
    mergePrimeMessages(existing.messages, contribution.messages);
    if (status.detail !== undefined) {
      const details = existing.statusDetails[state] ?? [];
      details.push(status.detail);
      existing.statusDetails[state] = details;
    }
  }

  const groups: PrimeStatusGroup[] = Array.from(statusesByGroup.entries())
    .sort(([, left], [, right]) => left.firstIndex - right.firstIndex)
    .map(([id, statusGroup]) => {
      const state = aggregateConfigState(statusGroup.states);
      return {
        id,
        label: statusGroup.label,
        state,
        detail:
          statusGroup.messages[state] ??
          (state === 'configured'
            ? undefined
            : statusGroup.statusDetails[state]?.find(
                (detail) => detail.trim() !== ''
              )),
      };
    });

  if (groups.every((group) => group.state === 'configured')) {
    return '';
  }

  const lines: string[] = ['## Configuration Status', ''];

  for (const group of groups) {
    lines.push(formatConfigStatusLine(group));
  }

  lines.push('');
  return lines.join('\n');
}

function primeMessagesByState(
  messages: AidePrimeStatusMessages | undefined
): Partial<Record<ConfigState, string>> {
  if (messages === undefined) return {};
  return {
    configured: messages.configured,
    'not-configured': messages.notConfigured,
    misconfigured: messages.misconfigured,
  };
}

function mergePrimeMessages(
  target: Partial<Record<ConfigState, string>>,
  source: AidePrimeStatusMessages | undefined
): void {
  const sourceByState = primeMessagesByState(source);
  for (const state of [
    'configured',
    'not-configured',
    'misconfigured',
  ] as const) {
    target[state] ??= sourceByState[state];
  }
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

function collectPrimeStatuses(
  services: AideHostServices
): Effect.Effect<readonly ResolvedPrimeStatus[], unknown, never> {
  const contributions = services.primeContributions().flatMap((entry) =>
    (entry.capability.status ?? []).map((contribution) => ({
      pluginId: entry.pluginId,
      contribution,
    }))
  );

  return Effect.all(
    contributions.map(({ pluginId, contribution }, index) =>
      contribution.status().pipe(
        Effect.map((status) => ({
          index,
          contribution,
          status: validatePrimeStatus(pluginId, contribution, status),
        })),
        Effect.catchAll((error) =>
          Effect.succeed({
            index,
            contribution,
            status: fallbackPluginStatus(
              pluginId,
              contribution.label,
              formatUnknownError(error)
            ),
          })
        )
      )
    ),
    { concurrency: contributions.length || 1 }
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

function collectPrimeSections(
  services: AideHostServices
): Effect.Effect<readonly AidePrimeSection[], unknown, never> {
  const sectionProviders = services
    .primeContributions()
    .flatMap((entry) =>
      entry.capability.sections === undefined ? [] : [entry.capability.sections]
    );

  return Effect.all(
    sectionProviders.map((sections) =>
      sections().pipe(
        Effect.map(validatePrimeSections),
        Effect.catchAll(() => Effect.succeed([]))
      )
    ),
    { concurrency: sectionProviders.length || 1 }
  ).pipe(
    Effect.map((sections) => sections.flat()),
    Effect.map((sections) => [...sections].sort(sortPrimeSections))
  );
}

function formatPrimeOutput(
  configStatus: string,
  sections: readonly AidePrimeSection[]
): string {
  const parts = ['# aide - Jira & Git Hosting Integration', ''];

  if (configStatus) {
    parts.push(configStatus);
  }

  parts.push(
    'Use aide instead of az/gh/jira CLI tools. Auto-discovers org/project/repo from git remote.',
    '',
    ...sections.flatMap((section) => [section.body, ''])
  );

  return parts.join('\n').trim();
}

export function buildPrimeOutputEffect(): Effect.Effect<
  string,
  unknown,
  AideHostServicesTag
> {
  return Effect.gen(function* () {
    const services = yield* AideHostServicesTag;
    const [statuses, sections] = yield* Effect.all(
      [collectPrimeStatuses(services), collectPrimeSections(services)],
      { concurrency: 2 }
    );

    return formatPrimeOutput(buildConfigStatusSection(statuses), sections);
  });
}

export async function buildPrimeOutput(opts: {
  readonly services: AideHostServices;
}): Promise<string> {
  return Effect.runPromise(
    buildPrimeOutputEffect().pipe(
      Effect.provideService(AideHostServicesTag, opts.services)
    )
  );
}

export function buildPrimeCommandEffect(): Effect.Effect<
  CommandResult,
  unknown,
  AideHostServicesTag
> {
  return buildPrimeOutputEffect().pipe(Effect.map(textResult));
}

export function makePrimeCommandDescriptor(): AideCommandDescriptor<
  object,
  unknown,
  AideHostServicesTag
> {
  return defineAideCommand<object, unknown, AideHostServicesTag>({
    id: 'prime',
    route: 'prime',
    summary: 'Output aide context for session start hook',
    run: () => buildPrimeCommandEffect(),
  });
}

export const primeCommandDescriptor = makePrimeCommandDescriptor();
