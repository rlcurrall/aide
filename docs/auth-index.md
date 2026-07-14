# Scoped auth index

The operating-system keyring API used by aide can read an exact key but cannot
enumerate keys. Scoped credentials therefore have a separate identity-only
catalog so a later account-discovery layer can find their exact targets.

## Ownership and format

Each canonical provider owns one document under:

```text
auth-index:v1:provider:<encoded canonical provider id>
```

The key and document are both versioned. Provider aliases are canonicalized
before selecting the key, so `ado` and `azure-devops` share the
`azure-devops` document. Per-provider documents keep corruption and
read-modify-write activity isolated to one provider and let future external
providers use the same storage policy without a global registry migration.

Version 1 has this complete allowlist:

```json
{
  "version": 1,
  "providerId": "github",
  "scopes": [
    {
      "providerId": "github",
      "host": "github.com",
      "account": "octocat"
    }
  ]
}
```

Top-level fields are exactly `version`, `providerId`, and `scopes`. Scope
fields are limited to `providerId`, `host`, `org`, and `account`, with only the
fields belonging to that provider's canonical identity retained. Tokens,
PATs, API keys, credential payloads, prompt values, labels, arbitrary metadata,
and stored credential-key strings are forbidden. A credential target is always
reconstructed from the canonical scope.

### Canonical bytes and fail-closed decoding

Version 1 has one byte representation, produced by the auth-index serializer:

- The document members are emitted in `version`, `providerId`, `scopes` order.
- Each scope emits `providerId`, `host`, then optional `org`, then optional
  `account`. Values are the normalized canonical values used to reconstruct the
  credential target.
- Scopes are sorted ascending by reconstructed credential key using JavaScript
  string comparison. Two scopes that reconstruct the same key are forbidden,
  even if their other allowed metadata differs.
- The serializer uses compact `JSON.stringify` encoding. It emits version as
  the number `1`, no insignificant whitespace or byte-order mark, and no
  trailing newline or other bytes.

For example, the complete canonical empty GitHub index is exactly:

```text
{"version":1,"providerId":"github","scopes":[]}
```

Documents are treated as hostile input. Decoding first uses `JSON.parse` only
for JSON syntax, then strictly validates the parsed structure, exact field
allowlists, required fields, scalar types, version, canonical provider
ownership, canonical scope values, and unique reconstructed targets. It then
sorts the validated scopes, serializes the result with the same sole serializer,
and requires byte-for-byte equality with the stored value.

Stored `host`, `org`, and `account` text must be well-formed UTF-16. Lone high
or low surrogates, including JSON-escaped forms, are rejected before scope
normalization or credential-target reconstruction; valid surrogate pairs and
other Unicode text remain subject to the provider's ordinary field semantics.

The same well-formedness rule applies at the runtime scope boundary. Every own
scope identity field is checked before normalization, URL parsing, target-key
construction, encoding, lock acquisition, or keyring I/O. Pure scope
normalizers and scoped-key builders return their ordinary `null`/empty result;
scope-consuming Effect APIs and live compatibility adapters fail with
`AuthStoreValidationError` code `invalid-target`. Azure DevOps identity consists
only of canonical host and organization, so optional runtime `account` input is
validated but is not retained in normalized scopes or serialized index entries.

That final equality is also the duplicate-member proof: the serializer emits
every allowed object member exactly once, so any input containing a repeated
top-level or scope member differs from the serialized bytes, whether the
duplicate values agree or conflict and regardless of which value `JSON.parse`
retains. The same check rejects reordered members or scopes, alternate
whitespace, escaping or number spellings, and trailing bytes. Structural
validation separately rejects malformed JSON, arrays or other nonobjects where
objects are required, extra or missing fields, wrong scalar types, invalid or
noncanonical providers/hosts/accounts, provider mismatches, unsupported or
future versions, invalid entry shapes, and duplicate semantic scopes.

Every rejection is fail-closed. The safe `AuthIndexDocumentError` identifies
only the canonical provider and bounded failure category; it never includes the
raw document. The invalid value is not repaired, rewritten, or partially
consumed. List/enumeration, write, and delete stop after the one index read:
they do not read a reconstructed credential and do not set or delete either an
index or credential. Manual deletion of the affected provider index remains the
explicit recovery action described below.

Valid returned scopes are fresh, frozen, null-prototype snapshots in canonical
order. Only a missing key (`null`) means absent: an empty credential value is
still live, while an empty index value is malformed JSON.

Legacy no-scope credentials are not indexed and are never rewritten. A later
discovery layer can merge a separate legacy probe without inventing an account
identity.

## Effect service ownership and composition

The implementation has three ownership boundaries:

- `auth-index-codec.ts` owns provider/scope canonicalization, the versioned
  schema, hostile-document decoding, canonical serialization, and document
  errors. It is pure apart from returning decode failures in an Effect channel.
- `auth-keyring.ts` owns `KeyringService`, `KeyringUnavailableError`, and the
  explicit `KeyringLive` Bun adapter. `KeyringService` is an explicit
  `Context.Tag`; it has no embedded `Default` layer. `KeyringLive` is the only
  production adapter that reads `Bun.secrets` and the only auth-store code that
  converts its Promises with `Effect.tryPromise`.
- `auth-store.ts` owns credential/index orchestration and the public store API.
  Its `*Effect` operations require `KeyringService` in their environment and do
  not run Effects or provide the live adapter internally.

Trusted built-in plugin descriptors declare `KeyringService` for auth and
auth-status operations that actually access the store. Auth status, account
discovery, login, logout, Prime status, and pull-request auth status carry
independent environment parameters; Prime sections and pull-request
matching/resolution remain `never`. Core host invocation preserves each
operation's requirement. Trust does not imply provisioning: each trusted
descriptor is constructed by the matching `defineAideCommand.none`,
`.internalHost`, `.keyring`, or `.internalHostAndKeyring` factory and records
that choice in an immutable private runtime identity. Registration and replay
reject any cast-based attempt to pair the descriptor with another label, and
the runner provides exactly the recorded environment. This command-level
provisioning identity is distinct from the plugin's trusted/external
registration provenance.
`registerCommands` requires its caller to supply the keyring layer. The CLI
entry point supplies `KeyringLive` once, while tests can pass an isolated
in-memory or fault-injecting layer through the complete descriptor or legacy
yargs route. Prime's descriptor requires only internal host services; its host
dispatcher provides the captured layer once around the batch of trusted status
operations. Existing
unsuffixed Effect functions and Promise helpers are deprecated live
compatibility boundaries; the Promise helpers only provide `KeyringLive`, run
the outer Effect, and rethrow the typed failure itself.

`KeyringService` is an ordinary explicit `Context.Tag`; service objects are
constructed as values satisfying `KeyringServiceShape` and installed with
`Layer.succeed`, `Layer.sync`, or `Layer.scoped`. There is no `KeyringService.make`
helper and no hidden default layer.

GitHub credential resolution composes `resolveAuthSecretEffect` directly. Its
injectable core has a concrete auth-store/probe error channel and never runs a
nested Effect or re-provides a captured service. Only the deprecated Promise
adapter supplies `KeyringLive` and converts the outer Effect back to Promise
behavior.

The exported external plugin descriptor fixes operation environments to
`never`, and its public host-services contract contains only immutable
service-free snapshots and mediated service-free methods. It does not export
the keyring or internal host tags. Registry-owned plugin snapshots and
capability entries retain mandatory trusted/external provenance. Exact
snapshot replay preserves that provenance, while cloned or forged
provenance-bearing snapshots fail closed; trusted auth/Prime discovery
explicitly excludes external capabilities. When internal auth or Prime
orchestration invokes an external operation, `Effect.mapInputContext` replaces
its input with `Context.empty()`;
using `Effect.provide(Context.empty())` would only merge and is not the
isolation boundary. External plugins therefore receive no raw keyring or
internal host authority from this internal composition seam. Auth and Prime
status callbacks are invoked lazily inside their provenance-specific boundary,
so synchronous callback throws follow the same provider normalization or Prime
fallback behavior as failures from the returned Effect. Prime section
callbacks are service-free and run beneath empty-context replacement for both
trusted and external registrations.

Operational failures use stable Effect tagged errors. In addition to
`instanceof`, callers can discriminate `KeyringUnavailableError`,
`AuthIndexDocumentError`, `AuthIndexConsistencyError`, provider/reference
errors, and `AuthStoreValidationError` through `_tag`. Expected service,
document, coordination, and validation failures stay in the Effect error
channel. Unexpected programming defects are not caught and relabeled as one of
those failures.

## Consistency and recovery

All scoped writes, deletes, catalog reads, stale-entry repairs, and compensation
run under one cross-process lease for the canonical provider. Alias forms such
as `ado` and `azure-devops` therefore coordinate on the same lease. Different
canonical providers use different targets and do not wait for one another. The
lease covers the initial index snapshot, every credential and index mutation,
and any reconciliation or whole-document rollback before it is released. In
particular, another cooperating aide process cannot observe and prune the
index-first window used to create a new target, and a rollback cannot overwrite
a successful update that acquired the lease later.

Coordination uses `proper-lockfile`'s atomic-directory lease with a refreshed
mtime. On macOS and Linux the targets live below the resolved
`/tmp/aide-auth-index-locks-<uid>` directory. The directory must be owned by the
current user with mode `0700`; target names are SHA-256 hashes of canonical
provider ids and must be regular user-owned `0600` files. An absolute
`AIDE_AUTH_INDEX_LOCK_ROOT` override is available to tests and embedded
runtimes, but its parent and final directory are subject to the same ownership,
permission, and symlink checks. Unsafe or unavailable locations fail closed
before the keyring is read.

Acquisition retries are bounded (normally about six seconds on a responsive
filesystem). Active leases refresh every five seconds and become eligible for
stale-owner recovery after 30 seconds, including after `SIGKILL` or a fatal
process crash. Normal process exit releases immediately. Effect interruption
always runs the release finalizer; because keyring promises are not cancellable,
an already-started read/mutate/repair transaction finishes before that normal
release.

Losing heartbeat ownership is different from an ordinary acquire or release
failure. `proper-lockfile` has already stopped refreshing and marked the lease
released before it invokes the compromise callback. Aide therefore writes one
fixed `AuthIndexLockCompromisedFatalError` line to stderr and synchronously exits
with status 1 from that callback. The callback error, lock target, provider,
credential values, and backend error text are never printed. The process does
not resume the protected promise or run later compensation after compromise;
the next valid owner remains authoritative.

Fail-stop begins when the heartbeat callback detects the loss, not necessarily
at the instant ownership was lost. A blocked event loop or stalled filesystem
callback cannot run the detector. If that stall lasts beyond 30 seconds, a
contender can recover the stale directory, and an already-submitted native
keyring operation may finish before the old process detects the loss. Once the
callback runs, aide exits before any further JavaScript continuation. State
already committed by the backend is not rolled back by process exit and must be
treated like any other crash-in-the-boundary state described below.

Ordinary `AuthIndexLockError` values are Effect `Data.TaggedError` failures.
They retain `instanceof AuthIndexLockError` compatibility and expose the literal
`_tag` `"AuthIndexLockError"`, so callers can use `Effect.catchTag` or Effect
`Match` without casts or message inspection. The stable `reason` discriminator
is `"contention-timeout"`, `"acquire-failed"`, `"release-failed"`, or
`"cleanup-failed"`; the last value identifies a release finalizer that failed
while completing interruption cleanup. The existing `phase`, `code`, canonical
`providerId`, and protected-operation outcome fields remain available.

The public constructor snapshots the five fields from guarded own data
descriptors. Ordinary, null-prototype, and custom-prototype records are accepted
when every field is a valid primitive and the provider id is already canonical.
Inherited or accessor fields, malformed values, and ordinary or revoked Proxies
are rejected with one fixed programmer-error diagnostic; caller extras are not
read. Alternate-new-target and subclass construction is deliberately unsupported
and fails with a fresh `TypeError` carrying that same fixed diagnostic before the
input is retained or an instance can escape. The safe primitive-only payload
passed to Effect and the completed base error instance are frozen, including
Effect's hidden plain-arguments payload and the public tag, fields, and local
stack descriptor.

These errors never retain a raw filesystem or `proper-lockfile` rejection as
`cause`, through constructor options, or anywhere else in their reachable
object graph. This intentionally trades access to backend-specific causes for
consistent redaction across error messages, local stacks, JSON, inspection, and
CLI rendering. Fixed `name`, `message`, primitive-only `toJSON`, string coercion,
and Node custom inspection behavior are defined directly on the
`AuthIndexLockError` prototype. That prototype and the exported constructor are
frozen after definition, preventing consumers from replacing those surfaces,
the class prototype chains, static properties, or `Symbol.hasInstance` through
the exported class. Promise-boundary normalization rejects Proxies before
descriptor inspection and never returns an externally supplied error by
identity. A safely constructed typed operational error is re-snapshotted into a
fresh frozen value so its stable reason and code survive without retaining the
original object.

This final-class boundary covers mutation through the exported constructor,
prototype, and completed base instances. It assumes the JavaScript language
globals and Effect runtime internals themselves have not been replaced; it does
not claim to defend against mutation of those external foundations.

A normal release failure takes precedence over the protected result because the
mutation may have succeeded while the lease state is unknown. A simultaneous
ordinary typed protected failure remains suppressed. If the protected operation
died, however, the defect-only portion of its Cause is retained after the
primary release failure; typed protected failures and interruption nodes are not
re-exposed through that composition. If interruption and cleanup failure
coincide, the Effect Cause retains interruption and also exposes the tagged
cleanup failure.

Keyring and consistency diagnostics are a redacted public contract. Beyond
standard locally generated `Error` metadata such as `name`, `message`, and the
local aide stack, a `KeyringUnavailableError` exposes a fixed `classification`
of `"unavailable"` and `operation` (`"get"`, `"set"`, or `"delete"` for errors
created by the keyring boundary). `"unknown"` is reserved for compatibility
with callers that directly construct the error. An `AuthIndexConsistencyError`
likewise exposes its stable message and local error metadata plus `operation`,
`phase`, canonical `providerId`, `rollback`, `residualState`, and the bounded
`failure` classification `"keyring-unavailable"`.

Neither error retains an OS-keyring rejection through `cause`, hidden or symbol
properties, closures, or copied messages/stacks. Backend values are never
inspected for diagnostics: arbitrary rejection values collapse to the fixed
classification. Operators can rely on the fields above for control flow and
incident summaries, but cannot recover a target key, credential or index value,
backend message, filesystem path, or backend-specific detail from the exported
error. The exported stack is the local aide error stack only.

For a new target, a write adds the index entry before creating the credential.
If credential creation fails, it restores the previous index. For an existing
but unindexed target, it writes the replacement credential first; if the index
update fails, it restores both the previous credential and index state. An
already indexed target normally only needs the credential replacement. If its
credential is missing at the starting snapshot, however, that pair is already
stale. A credential write that is verified unchanged preserves the ordinary
keyring error and leaves that pre-existing stale pair unchanged. A verified
desired write completes normally. A third credential value or failed
verification read instead reconciles to the coherent rollback target: absent
credential with that scope removed from the index, followed by reads of both
keys.

A delete snapshots the existing credential, deletes the exact reconstructed
target, and then removes its index entry. If cleanup fails, it attempts to
restore both the credential and original index. Partial-operation failures use
`AuthIndexConsistencyError`, whose `operation`, `phase`, `providerId`,
`rollback`, `residualState`, and `failure` fields describe the safe diagnostic
outcome.

Keyring mutation rejection is explicitly indeterminate; rejection does not mean
that the backend left the key unchanged. While still holding the provider
lease, aide immediately reads the exact mutated key and compares it with the
secret-safe in-memory snapshots. If the read proves the requested value (or
absence for delete), the mutation counts as applied and the transaction may
continue. If it proves the exact previous value, the mutation counts as a
no-op. A proved no-op preserves the ordinary `KeyringUnavailableError` when no
earlier transaction mutation needs compensation; after an earlier mutation it
instead triggers reconciliation. A third value or a failed verification read
is unknown and never produces a plain keyring error.

Reconciliation selects one complete target: normally the credential and index
snapshot from before the transaction, or the absent-credential/repaired-index
rollback target for stale indexed creation. Compensation promise settlement is
not trusted either. Aide performs every required compensation and then reads
both the credential and index targets under the same lease. A rollback of
`"succeeded"` with `residualState: "none"` is reported only when both reads
exactly prove the selected coherent target, including when a compensation
applied and then rejected. If either final read fails or differs, rollback is
`"failed"` and residual state is `"unknown"`; aide does not claim which key is
authoritative. This is a deliberately coarse residual: it does not expose raw
credential/index values, and it cannot distinguish a clean state whose final
verification failed from a genuinely partial state. The pre-existing
`"stale-index"` residual remains part of the public error vocabulary for states
that can be positively identified, but it is never used as a substitute for an
indeterminate read.

`rollback: "not-needed"` means exactly that no rollback or roll-forward was
attempted. It is used when an index-only stale-delete cleanup or enumeration
repair has an initially unknown outcome. Because a direct credential edit can
invalidate the scope set between reads, aide does not retry that index mutation
or verify only the index and call the operation successful. It returns
`residualState: "unknown"` with the fixed failure classification and discards
the original mutation rejection.

Enumeration verifies every indexed entry by reading its reconstructed
credential target. Missing credentials are omitted and the stale entries are
removed from the document. Rejected cleanup follows the same verification
contract: verified desired state succeeds, verified previous state preserves
the keyring failure, and an unknown result fails conservatively with
`rollback: "not-needed"` and `residualState: "unknown"`. Enumeration never uses
an index-only retry to turn an unknown repair into success.
Malformed or future-version documents are never overwritten automatically;
delete only the affected provider's index key to rebuild it through later
scoped writes. Existing credential entries remain untouched by that manual
index reset.

`Bun.secrets` still provides no multi-key transaction or compare-and-swap. The
lease gives cooperating aide processes on the same machine and OS user a serial
transaction boundary, but it cannot coordinate older aide versions, direct
keyring edits, other machines, or programs using a different lock root. A crash
inside the boundary can leave an incomplete operation: index-first creation and
delete crashes become stale entries that later enumeration repairs, while a
crash updating a previously unindexed credential can leave that credential
unindexed. A hung keyring call cannot be preempted while the event loop and
heartbeat remain responsive; the holder keeps refreshing its lease and
competing callers fail their bounded acquisition rather than entering
concurrently. A stalled event loop or heartbeat filesystem callback has the
stale-recovery and in-flight-state limitations above. Callers may retry after
the backend recovers or the 30-second stale threshold has elapsed.
