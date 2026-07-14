# Plugin API Boundary

This document defines the boundary that must hold before `aide add {plugin}` or
runtime external plugin loading exists.

## Public API

Plugin authors should import from `@aide/plugin-api` once a separate public
package is published. Inside this repository, `@aide/plugin-api` is a tsconfig
alias for internal/external-style tests; the current concrete package subpath is
`aide/plugin-api`. The public API is the small author-facing surface for:

- command descriptors and command results
- plugin descriptors and descriptor-backed command placement
- auth provider status, account discovery, prompt, login, and logout contracts
- prime status and help contributions
- pull request provider refs, matches, features, and operations
- mediated host services through `AideHostServicesTag`
- manifest, trust, capability, and conflict policy metadata

The implementation lives in `src/cli/plugin-api.ts`. The repository exports
`./plugin-api` from `package.json` as the concrete package boundary for
distribution experiments. A separate published `@aide/plugin-api` package can
be introduced later without changing the author-facing source surface.

Registry internals stay private to the host:

- `CommandRegistry`
- `OwnedPluginCapability`
- yargs adapter internals
- runtime context attachment for legacy yargs handlers
- raw yargs `CommandModule` registration helpers
- public-to-trusted descriptor conversion

## Trust Levels

`builtin` plugins are compiled into aide and registered through the trusted
internal registry path.

`trusted-local` plugins are future local user/project plugins that run in the
same process after explicit user trust.

`external` plugins are future installed plugins registered through
`aide add {plugin}`. Any plugin loaded into aide's process is explicitly
trusted code. The label describes provenance and the narrower service context
the host supplies; it does not mean the JavaScript is sandboxed.

Context replacement and the public Effect execution bridge prevent accidental
inheritance of host Effect services and FiberRefs. They cannot stop same-process
code from importing host modules, reading `process.env`, using filesystem or
network APIs, mutating globals, exiting the process, or exhausting CPU/memory.
Global mutation is therefore unsupported plugin behavior, not a threat that the
in-process runtime claims to sandbox or tolerate. Persistent mutation of the
Array intrinsics required by yargs is rejected at the host's command lifecycle
boundary as a runtime-integrity failure; mutation performed inside arbitrary
plugin code can still compromise that process before another boundary is
reached. A plugin that requires adversarial containment must not run in-process.
Untrusted plugins require a separate process with a narrow versioned IPC
protocol, restricted environment and OS authority, resource limits, and host
validation. A Worker can improve crash/loop isolation but still has the user's
OS authority; worker/process isolation remains future work.

## Registration Paths

`registerPlugin` is trusted/internal. It may accept raw yargs command modules
because it is used by compiled aide plugins while we migrate commands.

`registerExternalPlugin` is the future loader entry point. It accepts only
descriptor-backed public plugins and validates the descriptor and manifest
before mutating registry state.

Registration has a complete structural phase before semantic validation. It
captures the registration options and manifest, the plugin shell, capability
container and nested auth/Prime/pull-request records and operations, and every
descriptor-backed placement, extension, descriptor, route, and yargs record
into detached host-owned records and arrays. Plugin-id canonicality,
placement/descriptor identity validity and equality, namespace checks,
manifest compatibility, capability agreement, and yargs-builder rejection run
only after that detached graph exists. The command-kind discriminator is the
one intentional early branch: a wrong kind is rejected without reading its id,
descriptor reference, or later nested descriptor fields. Its placement shell
is still enumerated, bounded, and checked against the closed placement schema.

Closed record capture is followed by discriminator-specific closure on the
detached snapshots, before any snapshot is retained or passed to semantic
consumers. External command placements accept only the public `descriptor`
shape and reject a forged `module` field. Extension policies accept exactly
`same-plugin`, `open`, or `allowlist`: `pluginIds` is required for `allowlist`
and forbidden for the other two variants. Auth login input fields accept only
the text/secret fields or the select fields selected by `kind`; fields from the
other arm are rejected instead of being discarded. Missing, unknown, or
accessor-backed discriminators and malformed selected arms use the same fresh,
fixed capture failure as other structural defects. Variant validation reads
only host-owned detached snapshots and does not invoke retained callbacks.

Capture uses guarded own-data descriptors only. Every external record schema is
closed: guarded `Reflect.ownKeys` rejects symbols and unknown string keys,
including non-enumerable unknown accessors, with the fixed capture failure.
Known accessors, inherited required fields, live or revoked Proxies, non-plain
records, sparse or custom-prototype arrays, cycles, and malformed nested
record/array positions also fail before registry mutation. Array elements are
read only through dense indexed own-data descriptors, and host Arrays are
populated with explicit own data descriptors; capture never assigns an index,
iterates the source, or calls an inherited Array method. Non-index array
properties such as hostile own `map`, iterator hooks, `"01"`, or
`"4294967295"` are intentionally ignored without enumeration, accounting,
reading, retention, or invocation; this preserves the public Prime collection
contract.
Callback functions (`run`, auth, Prime, and pull-request operations) are retained
only as inert own-data values during capture and are never invoked by capture.
Accepted records use null-prototype host containers, accepted arrays retain
ordinary Array behavior, and both are recursively frozen before later
validation and retention. Optional pull-request feature fields are acquired
only through guarded own-data descriptors and copied by explicit definitions
into a frozen null-prototype record. Missing optional fields are never read
through `Object.prototype`; malformed feature values fail atomically with the
same fixed registration error. Structural failures use a fresh fixed
`External plugin metadata capture failed` Error with no external cause, value,
or text attached.

An optional record or array property that is explicitly present with value
`undefined` is captured as an inert scalar, just like descriptor `yargs`, and
is interpreted by detached semantic validation the same way as an absent
optional property. This applies only where the selected public declaration
actually has that optional property: an explicitly `undefined` field belonging
to another discriminated-union arm is still forbidden. A source record or array
may also appear in more than one compatible closed schema. Capture produces a
separate detached frozen snapshot for each schema; incompatibility in any
position still fails the complete registration. The active traversal marker
remains source-global, so recapture does not turn a cycle into an alias.

Capture is intentionally bounded. The current limits are 12 nested metadata
levels, 1,000 entries per array, 128 own string fields per record, 20,000
accounted items in one registration, 65,536 UTF-16 code units per string, and
1,048,576 total string code units. Accounting happens before semantic scans and
includes every visited record/array/specialized shell, every admitted record
key and dense array index key, and every source scalar occurrence. Placement
and descriptor identity strings are individually and cumulatively accounted
before exact validation and equality; only the captured placement primitive is
then written into both canonical host snapshots. Repeated references are
accounted as source occurrences while keys and descendant occurrences are
charged once for the source graph, even when a compatible second schema
produces another snapshot. The second schema is still fully traversed for
closure, type, cycle, and depth checks, so schema-specific validation cannot
bypass the limits. Active cycles still fail. These ceilings cover
the current public API; notably, the array limit matches the existing Prime
status ceiling and the single-string limit matches the public command result
ceiling. Raising a limit requires an explicit host/API compatibility decision
rather than accepting an unbounded structure.

The public plugin command descriptor intentionally does not expose
`yargs.builder` functions. The runtime boundary also rejects forged descriptors
that contain a builder. That keeps external commands from registering hidden
subcommands outside the registry graph. A later public argument metadata DSL can
relax this without exposing raw yargs.

## Manifest And Versioning

External plugins use an `AidePluginManifest`:

- `id` must match the descriptor id.
- `version` is required and non-empty.
- `aidePluginApiVersion` must equal the host `AIDE_PLUGIN_API_VERSION`.
- `capabilities` must exactly match capabilities provided by the descriptor.
- `loading.order`, `loading.after`, and `loading.before` are validated metadata
  for future deterministic loading.
- `conflicts.commands`, `conflicts.authProviders`, and
  `conflicts.pullRequestProviders` currently support only `reject`.

The host rejects unsupported API versions without invoking captured callbacks.
Installed plugins are still trusted same-process code: deterministic metadata
capture prevents registration-time accessor/Proxy ambiguity, but it is not a
CPU, memory, process, filesystem, network, or OS sandbox.

## Namespaces And Conflicts

External command ids must live in the plugin namespace:

- `plugin-id`
- `plugin-id:subcommand`

Route conflicts are still checked by the registry. Command extension policy is
parent-wide today:

- `same-plugin` is the default.
- `open` allows any plugin to add non-conflicting children.
- `allowlist` allows listed plugin ids to add non-conflicting children.

If external plugins need route-scoped grants later, add a new extension policy
variant rather than overloading the existing parent-wide policy.

## Reserved IDs

External plugins cannot claim aide core plugin ids:

- `aide-core`
- `azure-devops`
- `claude-code`
- `github`
- `jira`
- `legacy-auth`
- `pull-requests`

External pull request providers cannot claim core provider ids:

- `azure-devops`
- `github`

External auth providers cannot claim core auth provider names or command names:

- `ado`
- `azure-devops`
- `github`
- `jira`

Core providers are host-owned. External providers can still represent their own
repository refs through `kind: "external"` with their own provider id.

## Auth Providers

Auth providers own credentials for a backend or account family. A provider id
is dynamic and plugin-owned; host commands should not pin a static list of auth
providers when the registry can supply the registered providers.

Provider ids are canonical lowercase ASCII identifiers of 1–64 characters.
They must start and end with a letter or digit; interior letters, digits, `-`,
`_`, and `.` are supported so external providers can use vendor namespaces.
Path separators, control characters, and JavaScript prototype property names
are rejected. Runtime auth-store callers may use surrounding ASCII whitespace
and ASCII case variants, and the compatibility alias `ado` converges to
`azure-devops`, but plugin descriptors must declare the canonical form.

An auth provider exposes:

- `providerId` and `label` for discovery and display.
- optional login/logout command names and aliases through operation metadata.
- `status(request?)` for lightweight availability and configuration checks.
- optional `accounts()` for scoped account discovery.
- optional `login` metadata for host-rendered login flags/prompts.
- optional `logout` metadata for command names/aliases and future summary text.
- optional `operations.login(request)` and `operations.logout()` for
  credential mutation.

Login metadata is intentionally small:

- command name/aliases, independent from provider id
- text, secret, and select fields
- field key, label, description, required/default hints, validation, and stdin
  eligibility
- optional env migration metadata for `--from-env`

`login(request)` receives structured values, an optional `fromEnv` intent, and
an optional prompt adapter. The prompt adapter is deliberately auth-focused
instead of yargs-focused: plugins request text or secret input by label and
validation function, while the host decides how that prompt is presented.

`aide login` and `aide logout` are still yargs-backed, but they now discover
auth providers from host services and build provider commands/options from
metadata. Built-ins keep compatibility routes such as `aide login ado`, but the
command files no longer import Jira/GitHub/Azure DevOps plugin factories.
External-style tests prove a newly registered auth provider can drive login and
logout without editing the command files.

Logout summaries are captured in metadata but are not rendered in per-provider
logout help yet because `aide logout` remains a positional command with dynamic
choices. If provider-specific logout help becomes important, generate logout
subcommands the same way login commands are generated.

Auth operations return typed results and messages; they should not print
directly. For externally registered providers, one host-created invocation
program performs callback construction, return recognition, genuine returned
Effect execution, host composition, composed-output recognition, composed
Effect execution, and result validation. The entire program runs in the single
public empty-Context/empty-FiberRefs Runtime. The caller fiber only launches
that program, awaits and validates its Exit, rehydrates it, and handles launch
settlement/cancellation. Top-level Proxy
returns (including Proxies around genuine Effects) are rejected without
invoking traps. Primitive, plain-object, revoked-Proxy, structurally invalid,
or unlaunchable returns become fresh fixed auth-domain errors. Callback,
recognition, composition, and Runtime-launch failures discard the rejected
value: attacker messages, stacks, fields, descriptors, causes, and reachable
objects are not retained or rendered.

Successful status, accounts, login, and logout results use the same guarded
snapshot validator for public and trusted providers. Accepted object fields
must be own data properties on ordinary or null-prototype records; accessor,
inherited, Proxy, revoked-Proxy, unreadable, or unsafe shapes are rejected with
a fresh fixed `InvalidAuthProviderOperationResultError`. Arrays are traversed
only through their own `length` and dense indexed data descriptors. Plugin
`map`, `forEach`, iterators, coercion, `toJSON`, inspection hooks, and nested
accessors/Proxy traps are never invoked. Accepted values are copied to fresh
frozen host arrays and objects before they leave validation. Every intermediate
and final account/message collection is populated with explicit own index data
definitions; metadata-key traversal uses the same guarded descriptor loop.
Validation does not route these pure snapshots through `Effect.all` or another
collection bridge that could perform ambient indexed assignment.
The adjacent scope-argument, canonical GitHub request/environment/probe, and
stored-secret selection paths capture their own-property, descriptor,
prototype, Array-classification, and property-definition intrinsics before
plugin/provider execution. Host tuple, candidate, and key Arrays are consumed
through bounded own-data descriptor loops, and null-prototype records are
populated by explicit property definitions; these stages do not perform late
`hasOwnProperty`/`Object.hasOwn` lookup, Array iteration or `push`, or dynamic
property assignment.

The bounded auth result contract is:

- at most 1,000 accounts;
- at most 1,000 result messages, each at most 1,024 UTF-16 code units;
- at most 100 metadata entries;
- metadata keys contain 1–128 UTF-16 code units, are strings, and may not be
  `__proto__`, `constructor`, or `prototype`;
- metadata string values contain at most 1,024 UTF-16 code units; finite
  numbers and booleans retain their existing support; symbol keys are rejected.

This intentionally tightens compatibility for provider results that previously
depended on getters, inherited fields, sparse/Proxy arrays, custom collection
protocols, symbol/unsafe metadata keys, or unbounded collections/text. Ordinary
documented result shapes, provider/scope matching, source-kind rules, and
primitive metadata values are unchanged.

A genuine returned Effect keeps its Exit/Cause semantics. Success proceeds to
host result validation and frozen snapshots. Auth's typed-Fail contract maps
Fail nodes to a fresh `AuthProviderOperationError`; external failure payloads
are deliberately discarded. Die and Interrupt nodes remain structured causes,
and mixed Causes retain their structure with only Fail nodes mapped. Explicit
operation timeouts remain outside the boundary, forward interruption, and join
ordinary nested finalizers before returning the timeout error. The login prompt
adapter is a continuation inside the same isolated returned Effect graph.

### Internal auth-store dependency

The auth index and OS keyring are host-owned infrastructure, not new external
plugin authority. Built-in and trusted internal plugins that need the store
should depend on its Effect service through the suffixed core API:

```ts
import { Effect } from 'effect';
import { KeyringService } from '@lib/auth-keyring.js';
import {
  writeAuthSecretEffect,
  type AuthStoreError,
  type AuthStoreScope,
} from '@lib/auth-store.js';

function saveCredential(
  providerId: string,
  payload: string,
  scope: AuthStoreScope
): Effect.Effect<unknown, AuthStoreError, KeyringService> {
  return writeAuthSecretEffect(providerId, payload, scope);
}
```

This is an explicitly internal contract. `AidePluginDescriptor`, used only by
trusted in-process registration, has separate environments for auth status,
account discovery, login, logout, Prime status, and pull-request auth status.
Only operations that read or mutate the auth store require `KeyringService`.
Prime sections, pull-request matching/resolution, and pull-request operations
remain service-free. The invocation helpers preserve the environment of the
specific operation they invoke, so a missing service is a composition/type
error rather than a hidden backend choice.

Trust and service provisioning are separate command properties. Internal
descriptor registrations are trusted, but each carries one exact provisioning
discriminant: `none`, `internal-host`, `keyring`, or
`internal-host+keyring`. Registration helpers pair each discriminant with the
matching Effect environment, and snapshots, extension routing, and nested
registry entries preserve it. A service-free trusted command such as `whoami`
therefore receives no host or keyring service merely because it is trusted;
Prime declares only internal host services and delegates trusted status
execution to the host dispatcher. A trusted command that needs only one
service receives only that service.

Trusted descriptors must be constructed with one provisioning-specific
internal factory: `defineAideCommand.none`, `.internalHost`, `.keyring`, or
`.internalHostAndKeyring`. Those factories fix the Effect environment to
`never`, `AideInternalHostServicesTag`, `KeyringService`, or the union of the
last two, respectively. They do not expose an environment type parameter that
could be paired with a different runtime label. The canonical internal command
shape is:

```ts
const descriptor = defineAideCommand.keyring<Args, CommandError>({
  id: 'example:refresh',
  route: 'refresh',
  summary: 'Refresh the example credential',
  run: (args) => refreshCredential(args).pipe(Effect.map(() => emptyResult)),
});

export const examplePlugin = defineAidePlugin({
  id: 'example',
  summary: 'Example built-in',
  commands: [pluginCommandDescriptor.keyring(descriptor)],
});
```

Each factory returns an instance of an unexported class. Its ECMAScript private
fields retain runtime constructor ownership and the immutable provisioning
identity; declaration emit intentionally represents those fields only as an
untyped `#private`. A separate unexported `unique symbol` prototype method uses
the environment parameter invariantly, so emitted declarations retain the
exact environment distinction for downstream TypeScript consumers. The symbol
is not exported, and the prototype method is non-enumerable. Object spread
therefore copies neither the declaration nominality member nor the runtime
private fields, so spreading even a real trusted descriptor loses static trust
and runtime ownership. Raw objects, raw spreads, and cast forgeries cannot opt
into trusted provisioning. Casting a genuine descriptor to another variant
also fails: helper erasure, registry snapshotting, registered-entry creation,
and snapshot replay all compare the requested label with the constructor-owned
identity and reject a mismatch. Snapshots retain a newly constructed, frozen
descriptor with the same identity; no path relabels it. Public plugin
descriptors remain a separate structural type and cannot manufacture trusted
authority.

Public descriptors use a separate registry entry and runner. The public runner
provides only `AideHostServicesTag`; external commands cannot select an
internal provisioning variant. It invokes the public callback only inside the
shared guarded boundary, recognizes the returned Effect before composing it,
statically provides exactly `AideHostServicesTag`, recognizes the composed
Effect again, executes it in the module-private empty Runtime, and validates the
successful `CommandResult` before yargs receives anything to render. The yargs
adapter neither accesses a returned value's plugin-owned `pipe` property nor
uses the default Effect Runtime for this path; its Promise handoff delegates to
the public boundary module's existing private Runtime.

Public command boundary failures are fresh `PublicCommandHostError` values.
Their closed reasons and diagnostics are fixed by the host: callback throw,
invalid Effect return, composition failure, invalid execution, or invalid
result. Thrown/rejected values are discarded without retaining their identity,
text, stack, cause, descriptors, or reachable data. Failures produced by a
genuinely admitted command Effect are different: typed Fail values, defects,
interruptions, and mixed Cause structure pass through unchanged. Outer
interruption and timeout abort the nested execution and join ordinary command
finalizers before completing.

Successful command results must be ordinary or null-prototype records with an
own data `_tag`. `Empty` snapshots retain only that tag. `Text` also requires an
own data string `text` of at most 65,536 UTF-16 code units. Top-level Proxies,
revoked Proxies, arrays, class instances, accessors, inherited fields, unknown
tags, missing/non-string text, and overlong text are rejected. Validation reads
only those bounded own data descriptors, then copies accepted values into fresh
frozen host records. Rendering therefore sees only host-owned data; unrelated
plugin fields are never retained or inspected. This is deterministic
same-process validation, not sandboxing.

At the trusted runner, the provisioning switch installs exactly the declared
services and each branch reaches a provably service-free Effect before
`Effect.runPromise`. `registerCommands` has no live default: the CLI entry point
explicitly passes `KeyringLive`, while tests pass an isolated
`Layer<KeyringService>`. Internal host-service construction captures that same
caller-owned layer for trusted capability dispatch; neither Prime nor the auth
command helpers select or provide `KeyringLive`.

`AidePublicPluginDescriptor` in the exported `aide/plugin-api` instantiates
every capability operation with `R = never`. Its public command descriptor
accepts only the supported host-service environment (with a separate
service-free alias), and its Prime and pull-request capability aliases expose
no caller-selectable environment parameter. Plugin authors therefore cannot
widen runtime authority by supplying an arbitrary `R`. That API exports a distinct
`AideHostServices` contract: auth and Prime discovery return immutable,
service-free metadata snapshots, and pull-request methods are host-mediated
service-free Effects. It does not export `KeyringService`, internal descriptor
types, trusted capability snapshots, or the internal host-services tag.
`CommandRegistry.plugins()` returns frozen, registry-owned registration
snapshots rather than bare descriptors. Each snapshot has mandatory `trusted`
or `external` plugin provenance plus a nominal runtime identity. Plugin
provenance answers who registered the plugin and controls capability isolation;
command provisioning identity answers which Effect services one trusted
command may receive. Neither property implies or rewrites the other. Passing
that exact snapshot to the internal `registerPlugin()` replay API preserves provenance;
an external snapshot can never become trusted through replay. Cloned, spread,
or forged values that carry a provenance field fail closed because they have
lost registry ownership. Raw descriptors remain the ergonomic trusted
in-process registration path, while public plugins still enter only through
`registerExternalPlugin()` with a manifest. Registry-owned capability entries
also carry mandatory provenance, with no missing-provenance fallback. The
`trustedAuthProviders()` and `trustedPrimeContributions()` APIs therefore never
contain external operations.

Command routes are also registry-owned snapshot metadata. At every direct or
plugin registration boundary, string routes are retained by value and route
arrays are cloned and frozen, including routes for nested child commands. Route
collision keys and yargs registration both derive from that same canonical
retained route. Snapshot replay preserves the exact route values and provenance
while creating a new registry-owned snapshot, so caller mutation cannot change
help, dispatch, or collision identity. This is intentionally route-specific:
command callbacks, Effects, yargs builders, and arbitrary plugin runtime values
remain plugin-owned and are not recursively frozen.

After external metadata capture, registry validation, canonical routing,
collision checks, replay, capability discovery, public host-service snapshots,
and yargs handoff use bounded own-descriptor loops and descriptor-defined host
Arrays. Retained collection metadata remains ordinary dense frozen Arrays;
the registry's established mutable-copy accessors remain detached. These
host-owned structural and semantic stages never consult inherited plugin data.
The exported reserved-plugin-id predicates use direct string equality rather
than Array prototype methods. Registry and adjacent public-boundary own-data
checks use an `Object.hasOwn` primitive captured by the host before plugin
loading; they never dynamically resolve `Object.prototype.hasOwnProperty` or
`Function.prototype.call` after external code can run.

Yargs is third-party code and legitimately uses ordinary Array methods throughout
registration, recursive builder expansion, help generation, parsing, and
dispatch. The adapter therefore establishes one exact own-key and descriptor
baseline for the complete `Array.prototype` surface before the CLI loads its
plugin registry. This includes the numeric-index absence and the exact
`map`, `filter`, `some`, `push`, and `Symbol.iterator` data descriptors exercised
by the adversarial matrix, along with every other Array method yargs may use.
The CLI checks that baseline before
its first yargs construction. Each configured yargs instance also checks it
before command registration, nested command registration, `getHelp`/`showHelp`,
`parse`/`parseSync`/`parseAsync`, builders, and handlers. Future plugin loaders
must initialize this host boundary before evaluating an in-process plugin
module and must not call yargs after a failed check.

The check uses only captured descriptor operations and exact descriptor
comparison. It never reads an accessor, calls an inherited method, deletes a
numeric property, replaces an Array method, or restores a descriptor. Any
configurable or non-configurable divergence fails closed with a fresh fixed
`YargsRuntimeIntegrityError` and no external value, text, identity, or Cause.
The divergent descriptor is left byte-for-byte unchanged. This is a runtime
integrity precondition for entering yargs, not a claim that arbitrary plugin
global mutation can be sandboxed inside the same JavaScript process.

Tests that deliberately replace or add properties on `Object.prototype` or
`Array.prototype` run in dedicated child processes, never in a shared Bun test
worker. The process tests exercise source and compiled-native lanes where the
behavior is release relevant, track the exact child, enforce a hard parent
deadline, send `SIGKILL` to that exact PID on expiry, and await that exact
child's exit before cleanup. This isolation keeps the default concurrently
scheduled `bun test` suite deterministic while preserving ambient-mutation
coverage. It is test isolation only; it does not expand the trusted
same-process runtime contract or imply containment of arbitrary global
mutation.

Public command, Prime, auth-provider, and pull-request Effects run through the single internal
`invokePublicCapabilityEffect` boundary. The host constructs one suspended
invocation program containing callback construction, returned-Effect
recognition, host composition, composed-Effect recognition and execution, and
caller-specific result validation. Before Effect
recognition, the host uses the captured `node:util.types.isProxy` primitive,
which invokes no Proxy traps and rejects ordinary and revoked top-level
Proxies. Because public `Effect.isEffect` performs property lookup, the host
first walks the finite non-Proxy prototype chain using own property descriptors
until it finds the first public marker or reaches `null`. It accepts an own or
inherited public `Effect.EffectTypeId` data marker only when its own data `_V` matches
`ModuleVersion.getCurrentVersion()`, then calls `Effect.isEffect` after that
lookup is known to be trap-free. This admits Effect 3.21.4's official
own-marker and inherited-marker representations, including a separately loaded
same-version package, without imposing an inheritance-depth compatibility
restriction that Effect itself does not define. Ordinary JavaScript prototype
chains are finite and acyclic; every encountered value is checked with the
captured Proxy predicate before the next descriptor or prototype operation.
Marker/version accessors, Proxy markers or prototype links, malformed markers,
and version mismatches are rejected without invoking their hooks. Host-owned
static composition and composed-output recognition use the same admission rule.
No public callback value is composed before execution admission.

That complete invocation program is launched in one explicit nested `Runtime` through
`Promise.resolve().then(() => Runtime.runPromiseExit(...))`. That Runtime starts
with `Context.empty()` and `FiberRefs.empty()` and receives the outer
`AbortSignal`; it does not inherit services, tracing/logging FiberRefs, or other
caller runtime state. The callback, returned Effect, host composition, composed
Effect, and validation therefore all observe the initial empty Runtime state,
including during synchronous construction/traversal. The outer fiber performs
no callback recognition or composition. Synchronous launch throws, rejected
launch Promises, and malformed/Proxy launch settlements are
discarded without binding, formatting, or retaining the rejected value and
become fresh domain invalid-execution failures. A resolved `Exit` is converted
back into the outer Effect with its original Cause, so well-formed Success,
Fail, Die, Interrupt, and parallel/sequential mixed Causes retain structure.
Outer interruption and timeout abort the nested fiber, await its settlement,
and therefore join ordinary finalizers before completing. An uninterruptible or
nonterminating finalizer can still delay timeout completion.

Callback invocation throws are boundary failures too: auth-provider, Prime,
and pull-request domain errors retain only a fixed host-owned
classification/cause, never the thrown value, its identity, or its text.
Recognition and composition traps use the same discard-and-replace policy.
This intentionally changes legacy auth/PR diagnostic behavior that echoed
synchronous callback exception messages.
Failures and Causes produced by a genuinely admitted returned Effect are
different: those round-trip through `Exit` and retain their established domain
mapping or Cause structure.

Trusted Prime statuses do not use the empty public Runtime because they require
`KeyringService`. The host starts their batch from `Context.empty()`, provides
only the explicitly captured keyring layer, and shares one scoped acquisition
and release across the batch. No `AideInternalHostServicesTag` or arbitrary
caller service is provided. Public status, strict public sections, tolerant
public sections, repository Effect matchers, and the shared pull-request
operation core use the nested Runtime boundary. Prime sections remain
service-free for either provenance when exposed through public host services.
External auth-provider status, accounts, login, logout, and login prompt
continuations use that same Runtime boundary; trusted auth-provider callbacks
remain on the explicitly keyring-provisioned branch.

The nested Runtime and marker compatibility check are malformed-value
hardening, not Effect-object authentication or a sandbox. The public marker is
structural and forgeable. Effect 3.21.4 supports legitimate representations
whose private instruction layout is not a public contract, so the host does not
preflight `_op`, `_tag`, private instruction fields, or an entire Effect graph.
Same-process code can construct a compatible-looking malformed instruction
after admission; the Effect interpreter may reject before it can run that
graph's own finalizers. Installed in-process plugins are trusted to return
well-formed Effects. Process isolation is the only complete answer for hostile
code and hard deadlines.

Prime section validation uses bounded host-owned indexed traversal (at most
1,000 entries). Input Arrays must expose an own data `length`, only canonical
in-range own index keys plus `length`, and own data entries; strict traversal
requires every index while tolerant traversal drops missing or malformed
entries. Each section's `id`, `body`, and optional `order` are read only from
guarded own data descriptors. Array/section Proxies and accessors are rejected
without invoking their traps or getters. Snapshots copy only those fields into
fresh frozen host objects and an exact dense fresh frozen host Array, without
calling plugin-owned `map`, `flatMap`, or iteration protocols. Strict malformed
data becomes a fresh `PrimeContributionError`; tolerant rendering drops the bad
contribution or entry. The exported error
remains constructible for `instanceof`, `_tag`, and `catchTag`, but those public
signals are never treated as provenance. Its diagnostic plugin-id policy is
unchanged: 1–128 canonical ASCII characters are retained and every invalid
value becomes `<invalid-plugin>`.

Prime status results are read under one guarded traversal: `state` and `detail`
are each captured exactly once, validated only from those locals, and copied as
fresh primitives into a fresh frozen status object. Proxies, throwing/changing
getters, forged values, unsafe details, and later mutation cannot enter retained
output. Detail is a single line of at most 1,024 UTF-16 code units and rejects
C0/DEL/C1, CR/LF, bidi/format controls, surrogates, and Unicode line/paragraph
separators. Accepted returned detail is NFC-normalized before the 1,024-unit
retained bound and unsafe-category validation. Only interruption-only Causes
propagate. Every Cause containing a Fail or Die, including mixed
Fail/Die/Interrupt Causes, is discarded wholesale and becomes the fixed
`status Effect execution failed` fallback.

Prime status declarations are also registry-owned snapshots. Status arrays
must be dense data-property Arrays with at most 1,000 entries; top-level
Proxies, sparse/accessor/oversized arrays, and unreadable entries are rejected
atomically. Registration never calls plugin-owned `map` or iterator hooks, and
mutation after registration cannot affect output. External plugin ids and
Prime group ids are canonical lowercase ASCII identities of 1–64 characters:
they start/end alphanumeric, allow only interior `[a-z0-9._-]`, and reject
JavaScript prototype names. Prime group/contribution labels are NFC-normalized,
1–128 UTF-16 code units, have no leading/trailing whitespace, and reject
C0/DEL/C1, bidi/format controls, surrogates, and Unicode line/paragraph
separators. Prime status messages use the same single-line contract with a
1,024-code-unit bound. Malformed identity/metadata is rejected at registration,
not lossy-sanitized during rendering. Accepted declaration-message snapshots
are frozen null-prototype records whose retained messages are explicit own data
properties. Strict and tolerant section arrays are populated only through
explicit own index definitions, preserving strict fresh-error and tolerant-skip
behavior without consulting inherited numeric setters.

Pull-request matching, repository resolution, and operation invocation use a
structural provider view that excludes `authStatus`; registry convenience
resolvers are generic over the registry environments. Consequently a
provider's auth-status service may be service-free, keyring-backed, or a
different host service without coupling PR resolution to that service.
Provider selection does not invoke `authStatus`. Repository refs select by
provider id without calling a matcher; remote, URL, and repository-input
matchers otherwise run lazily beneath the shared public context-replacement
boundary. The same boundary contains callback construction and the returned
Effect for all pull-request operations, including methods retained by a
provider-bound view or branch context. These matcher and operation contracts
are Effect-environment-free for trusted built-ins as well as external plugins,
so neither branch inherits ambient keyring or internal-host authority from its
caller. Repository Effect matching and the shared nine-operation core guard
Effect recognition and synchronous composition independently of callback
invocation. Invalid returns, recognition traps, and composition traps become
fresh typed invalid-match or invalid-operation-result failures; execution
failures, defects, interruption, and finalization retain their existing
semantics. Timeout policy is deliberately split by operation kind. Matchers
retain `PullRequestProviderTimeoutError`; the five read operations
(`listPullRequests`, `getPullRequest`,
`getPullRequestDiff`, `listPullRequestComments`, and
`findPullRequestForBranch`) retain a definitive
`PullRequestProviderOperationTimeoutError`. The GitHub and Azure DevOps
adapters pass `Effect.tryPromise`'s `AbortSignal` through every PR client call;
their fetch transports propagate that signal through pagination, redirects,
GraphQL, and composite reads so an interrupted read cannot continue issuing
requests after the host returns. GitHub's `gh api` compatibility transport is
synchronous: it is checked before invocation but cannot be asynchronously
cancelled, and a host timeout cannot complete while that call blocks.

Raw remote, pull-request URL, and repository-input lookup values are available
only to provider matcher callbacks. Every exported resolution error retains the
existing string `value` field for compatibility, but that field is a host-owned
descriptor: URL userinfo, query, and fragment data is removed; strict SCP-like
values omit userinfo, query, and fragment data; and malformed, ambiguous, or
unbounded values become the fixed `<redacted>` sentinel. Repository descriptors
apply the same rule to nested URL/SCP-like components. The same descriptor is
captured for trusted diagnostics, rendering, serialization, and inspection, so
none of those surfaces holds the raw lookup input.

The four remote mutation operations (`createPullRequest`,
`updatePullRequest`, `addPullRequestComment`, and
`replyToPullRequestComment`) never turn a deadline into a definitive remote
failure. Their deadline produces a fresh fixed
`PullRequestProviderMutationIndeterminateError` stating that the operation may
have succeeded, must not be retried blindly, and requires remote-state
verification. The same host policy applies to external providers without
changing the provider-neutral callback contract. Built-in fetches are still
aborted to bound local work, but aborting an HTTP exchange cannot prove that a
server did not accept the request. A signal-blind compatibility Promise may
settle later; its existing Promise handlers observe that settlement, while the
caller has already received only the indeterminate classification. Ordinary
caller interruption remains an Interrupt Cause rather than being rewritten as
a timeout or typed failure, and the nested Runtime still joins ordinary
finalizers before returning.

The operation name is retained in the static error type throughout direct
provider calls, remote/repository/URL wrappers, operation contexts, and the
transitively public `AideHostServices` declaration. Consequently, each of the
five read methods admits only `PullRequestProviderOperationTimeoutError` and
each of the four mutation methods admits only
`PullRequestProviderMutationIndeterminateError`; the opposite deadline tag is
not part of that method's Effect error channel. This declaration precision
does not add a runtime export to `@aide/plugin-api`.

Nonfatal label/tag follow-up failures on built-in create/update operations use
fixed provider-owned warnings. Requested label/tag text, pull request numbers,
raw SDK rejection values or identities, messages, stacks, causes, credentials,
and request/response bodies are not copied into those diagnostics.

Some built-in operations still reach deprecated live compatibility
adapters internally; service-free typing and empty caller-context replacement
do not claim those bridges have already been migrated. The `authStatus`
callback is retained in the registered provider snapshot as metadata/callback
only. There is no `AideHostServices` invocation path for it today, and provider
selection and operations do not call or provision it.

Every successful public pull-request value crosses one module-private,
host-owned structural-capture layer before semantic validation or admission.
This includes synchronous `matchRemote` and `matchPullRequestUrl` results,
successful `matchRepository` Effect values, detached provider feature metadata,
and the complete success families for list, view, create, update, diff,
comments, add-comment, reply, and branch lookup. Each public record and union is
closed to its declared fields and selected discriminator arm. Capture rejects
unknown or symbol keys, inherited required values, accessors, live or revoked
Proxies, non-plain records, sparse/custom-prototype/extra-property arrays,
malformed structural positions, and cycles. It uses guarded own data
descriptors only: no ordinary read, `Object.entries`, coercion, iterator
protocol, or plugin-owned method/callback is used while traversing the source.

The host-owned capture schema graph follows the same non-executable property
rule. One internal constructor copies only enumerable own string data
descriptors from trusted schema definitions into fresh null-prototype records,
defines them as immutable data, rejects symbols, accessors, Proxies, duplicate
keys, and unsupported source shapes, then freezes the result. This applies to
schema and field nodes, record-field maps, discriminated-union variant maps,
and the top-level eleven-schema map. Required fields carry an explicit own
`optional: false`. Capture resolves every schema property and map entry through
`Reflect.getOwnPropertyDescriptor` plus own data-value validation; it never
uses `record[key]`. An inherited, missing, symbol, or accessor entry therefore
fails closed without evaluation. A discriminated union uses its fallback only
after the variant map has an own-data miss; the repository and match fallbacks
are rejecting schemas rather than permissive union arms. A missing top-level
schema always rejects capture.

Structural requiredness mirrors the declared public result types exactly:

| Public shape              | Required own fields                            | Optional own fields                                                            |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| GitHub repository         | `kind`, `host`, `owner`, `repo`                | none                                                                           |
| Azure DevOps repository   | `kind`, `org`, `project`, `repo`               | none                                                                           |
| External repository       | `kind`, `providerId`, `displayName`            | `metadata`                                                                     |
| Pull-request ref          | `number`                                       | none                                                                           |
| Remote/repository match   | `source`, `repository`                         | `priority`, `detail`, `pullRequest?: never`                                    |
| URL match                 | `source`, `repository`, `pullRequest`          | `priority`, `detail`                                                           |
| Provider features         | none inside the feature record                 | `draftPullRequests`, `reviewComments`, `threadedComments`, `enterpriseHosts`   |
| Author/comment author     | `displayName`                                  | `username`, `email`                                                            |
| List item                 | `id`, `title`, `status`, `createdAt`, `author` | `description`, `url`, `draft`                                                  |
| View item                 | all list-item requirements                     | list-item options plus `sourceBranch`, `targetBranch`, `labels`                |
| Diff file                 | `path`, `status`                               | `providerStatus`, `previousPath`, `additions`, `deletions`, `changes`, `patch` |
| Comment                   | `id`, `kind`, `author`, `body`, `createdAt`    | `updatedAt`, `url`, `filePath`, `lineNumber`, `parentId`, `providerType`       |
| Comment thread            | `id`, `replies`                                | `status`, `filePath`, `lineNumber`, `rootComment`                              |
| List result               | `repository`, `pullRequests`                   | `repositoryLabel`                                                              |
| View result               | `repository`, `pullRequest`                    | `repositoryLabel`                                                              |
| Create/update result      | view-result requirements                       | `repositoryLabel`, `warnings`                                                  |
| Diff result               | view-result requirements plus `files`          | `repositoryLabel`                                                              |
| Comments result           | `repository`, `pullRequest`, `threads`         | `repositoryLabel`                                                              |
| Add/reply mutation result | `repository`, `pullRequest`, `comment`         | `repositoryLabel`, `thread`                                                    |
| Branch lookup result      | view-result requirements plus `branch`         | `repositoryLabel`                                                              |

The capability-level `features` container itself is required even though every
feature key is optional. Missing required fields and own data fields whose value
is `undefined` both fail structural capture. Optional fields may be absent; an
own optional field whose value is `undefined` retains the existing compatibility
behavior and is omitted from the detached snapshot. For the non-URL match arms,
`pullRequest?: never` therefore permits only absence or that explicit-undefined
compatibility form; a pull-request object is structurally rejected. Known
GitHub and Azure discriminators always select their exact arm, so external or
fallback fields cannot compensate for a missing arm-specific requirement.

Accepted values become fresh recursively frozen host records and Arrays before
the existing repository/id/date/scalar semantics run. Repeated acyclic aliases
are captured independently per occurrence, so the public result contains
detached copies rather than retained plugin identity; repeated occurrences are
also charged repeatedly to every cumulative budget. Source mutation after
capture is irrelevant. The host captures reflection primitives before provider
execution and consumes every host-created `Reflect.ownKeys` Array through
bounded own-index data descriptors, including source records, Array shape
checks, schema fields, and external repository metadata; it never dispatches
the ambient Array iterator for those key lists. Semantic validation and copying of every operation
Array rereads dense own-data descriptors and defines entries on a normal host
Array explicitly; it does not use the source iterator, `some`, `push`, spread,
or inherited numeric setters. Any structural fault becomes a fresh fixed
`InvalidPullRequestProviderMatchError` or
`InvalidPullRequestProviderOperationResultError`; the external value, thrown
identity, text, and Cause are discarded. Synchronous validation is suspended
and guarded so a successful hostile value cannot escape as an Effect defect.
This policy applies only after a genuine plugin Effect succeeds. A Fail, Die,
Interrupt, or mixed Cause produced by the admitted Effect itself still follows
the shared invocation boundary's Cause contract, including cancellation and
finalizer joining. Resolver-specific matcher and operation wrapping maps the
whole Cause with `Cause.map`: every Fail leaf becomes the exact domain wrapper;
matcher wrappers replace the original failure payload with a fresh fixed
host-owned cause, while operation wrappers retain their existing original
failure value. Sequential and Parallel topology plus Die and Interrupt leaf
identities remain intact. The PR command adapter folds success or the complete Cause into a host-owned outcome
before the Promise boundary. Success resolves normally. Failure rejects with a
fixed host `PullRequestCommandEffectError`; no native `Error.cause` is installed
and the raw Cause is not stored or exposed after the rejection is created. A
private weak identity map holds only immutable primitive
display strings captured where the host actually emits a resolver, validation,
timeout, unsupported-operation, or provider wrapper. The outer Cause walk does
only an exact `WeakMap.get` for each Fail leaf. It performs no `instanceof`,
message/name/property read, prototype traversal, coercion, or inspection of the
leaf. Public-boundary tests embed an exact host-authoritative Fail identity in
Parallel and Sequential composites with Die and Interrupt leaves; the rendered
provider diagnostic proves that the exact leaf remains discoverable while a
hostile own `message` getter remains unread and the public Error has no own
`cause`. Resolver Effect-boundary tests separately assert exact Cause topology
and leaf identity before the command adapter intentionally redacts that private
structure. Calling an exported
typed error constructor does not populate display authority; subclasses,
prototype changes, Proxies, spreads, clones, and lookalikes remain generic.
Pure Fail, Die, and Interrupt, Parallel or Sequential mixed Causes, and
multiple Fail leaves therefore retain their full semantics through the Effect
boundary without exposing the raw Cause from the command Error. Effect
interruption is the cancellation mechanism: finalizers
finish before the fixed host rejection is observed, and the adapter does not
add a separate Promise cancellation channel. Command-local PR validation
factories use the same bounded capture rule before their Errors can reach the
renderer.

Both the global renderer and the PR-specific exit handler use one total miss
policy after those exact private diagnostic lookups. Primitive strings are
explicitly bounded to 16,384 UTF-16 units. Otherwise Bun's captured native
`Error.isError` brand intrinsic must accept the value, and the value must have
an own data `message` descriptor whose value is already a primitive string.
Independent Bun subprocess probes prove that the intrinsic rejects live Error
Proxies without unwrapping them or invoking `get`, `getPrototypeOf`,
`getOwnPropertyDescriptor`, or `ownKeys` traps. Inherited/accessor messages,
forged Error prototypes/tags, other objects/functions, and all rejected values
receive the fixed `Unknown error occurred` text. Renderer miss handling never
uses `instanceof`, prototype traversal, coercion, inspection, or live
message/name reads. Ordinary internal `Error` values retain their bounded own
data messages; host tagged errors that require richer text must capture a safe
own-data message or exact private diagnostic at emission.

Trusted built-in diagnostics use a separate provider-neutral internal path.
The host certifies only the exact module-owned GitHub and Azure plugin descriptor
objects in a private weak identity table. Registration propagates that
certificate out of band to the exact host snapshot capability and exact owned
capability entries; descriptors, capability records, and registry snapshots
never carry a formatter callback or diagnostic output. Raw trusted/local
descriptors, replayed snapshots, spread entries, public/external plugins, and
forged fields cannot acquire or retain authority. Diagnostic-property accessors
and callable Proxies are not read or invoked. GitHub and Azure host extractors
read diagnostics only from exact host-created errors registered in their own
private weak maps, and the registry accepts only a non-empty host string of at
most 16,384 UTF-16 units. This restores built-in authentication/configuration
guidance without inspecting an arbitrary failure. External and uncertified Fail
wrappers always retain their fixed cause-independent text; forged tags, classes,
provenance fields, accessors, Proxies, coercion hooks, and error messages cannot
select or populate the certified diagnostic channel.

The exact static GitHub and Azure descriptor graphs first acquire ownership of
every mutable definition container and are then recursively frozen before their
module exports can be observed. The owner performs a cycle-safe, symbol-safe
clone through own descriptors, never invokes accessors, and accepts only exact
Arrays plus ordinary/null-prototype definition records. Runtime clients,
Effects, results, Promises, Maps/Sets, classes, Proxies, and other arbitrary
runtime objects are not cloned or traversed. Unsupported definition values fail
closed.

The frozen owned graph includes the descriptor, command Arrays, capabilities,
pull-request features and operations, auth fields/metadata/operation records,
Prime contribution data, and every other nested mutable definition record or
Array. Callback functions are terminal shared values. The owning record makes
each callback slot non-writable, but neither a shared/imported callback object
nor its prototype record is traversed or frozen. This includes imported
`validateUrl` and shared login/logout callbacks. Every factory call creates
independent mutable auth fields/Arrays, metadata, Prime records, features,
operations, and other configurable containers; factory A shares no definition
container with factory B or the static export. Factory values remain
uncertified. Consequently the exact identity certificate cannot be paired with
an attacker-replaced callback before first registration or between repeated
registries without contaminating later factories or shared modules.

Diagnostic authority is never inferred from constructor, class, tag,
provenance, or live `Error.message` identity. Resolver-owned failures receive a
bounded primitive at their private host emission point; certified GitHub/Azure
provider wrappers may instead receive the bounded primitive returned by their
private host-created-error maps. Later mutation of a host-emitted wrapper's
message, name, prototype, or accessors cannot change that captured value.

The PR result capture ceilings are deterministic: the accounting policy admits
depths 0 through 8 and rejects a visit above depth 8, 1,000 dense entries per
Array, 128 own string fields per record, 20,000 visited source value
occurrences, 65,536 UTF-16 code units per admitted string, and 1,048,576 total
string code units per capture. Node accounting counts records, Arrays, and
scalar occurrences but not property/index names. Cumulative string accounting
does include admitted record keys and dense decimal index names as well as
string values. These reuse the established external-metadata ceilings except
for the exact PR depth bound. The current closed result schemas do not expose an
arbitrary recursive candidate that can reach both depths 8 and 9, so depth is
covered by a narrowly labeled schema/declaration/accounting source invariant,
not claimed as an end-to-end capture test. Reachable schema depths, exact
occurrence and code-unit limits, and their next rejected values are exercised
through direct and registered-provider boundaries. Raising any limit is a
public API and resource-policy decision.

This is deterministic same-process result validation, not hostile-code
containment. A trusted installed plugin can loop or allocate before returning,
mutate process globals, use filesystem/network/native authority, or otherwise
affect the process. Proxy preflight avoids invoking traps where the runtime
supports `node:util.types.isProxy`, and hard-deadline subprocess tests cover
the otherwise hang-prone traversal cases, but only process isolation with OS
resource controls can contain arbitrary plugin execution.

`createAideHostServices` is likewise generic over every registry environment
and constructs only the public, service-free host object. The built-in CLI
composition root separately calls `createAideInternalHostServices` with its
keyring-specialized registry; that internal object extends the public methods
with provenance-tagged auth/Prime registrations, trusted-only snapshots, and
the captured keyring dispatcher, while public command runners receive only its
`publicServices` member.

Existing unsuffixed auth-store functions and standalone auth Promise helpers
are deprecated live compatibility adapters for callers outside this migration.
Those auth adapters are not used by the yargs login/logout execution path:
legacy login/logout handlers use
the internal dispatcher, which provides the caller-supplied layer only for
trusted registrations and replaces context for external registrations.
Built-in Jira, GitHub, and Azure DevOps auth provider reads and mutations use
only the suffixed, injected path.

## Operation Boundary

Plugin operations are invoked through host-owned boundary helpers, not by
calling untrusted provider functions directly from command code.

Auth-provider, public Prime, and pull-request Effect-valued callbacks share the
single module-private nested Runtime bridge described above. Auth retains its
own request, prompt, result, typed-failure, and timeout policy around that core.

Both runner families retain the surrounding host pattern:

- catch synchronous operation throws
- reject non-Effect returns
- wrap provider failures in typed host errors
- apply explicit timeout policy only where appropriate
- validate result shape against the host contract
- freeze/snapshot request or result data before crossing the boundary

Auth keeps separate result/prompt semantics, but it must not create a second
Effect execution bridge. Trusted built-in auth providers remain a separate
provenance branch: only that branch receives the explicitly captured keyring
layer, and compatibility adapters mark trusted execution explicitly. Missing
provenance fails closed as public/external.

## Host Services

Plugins that need host-mediated operations should use `AideHostServicesTag`.
The current mediated services are:

- immutable auth-provider metadata discovery (no status/login/logout
  functions)
- immutable Prime metadata and service-free section discovery (no raw status
  functions)
- pull request provider resolution and operation invocation

- resolve provider for a git remote
- resolve provider for a pull request URL
- list pull requests for a remote
- get a pull request for a remote
- find a pull request for a branch
- get a pull request from a URL

Plugins do not receive the mutable registry through host services.

Trusted built-ins use the non-public `AideInternalHostServicesTag` when they
need raw internal capability functions. That tag and its service-bearing
snapshots are intentionally absent from `@aide/plugin-api`.
