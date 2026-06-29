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

`external` plugins are future semi-trusted plugins installed through
`aide add {plugin}`. External plugins run in-process; this is not a hard
sandbox. The registry boundary prevents accidental authority leaks, not
malicious code execution inside the process.

## Registration Paths

`registerPlugin` is trusted/internal. It may accept raw yargs command modules
because it is used by compiled aide plugins while we migrate commands.

`registerExternalPlugin` is the future loader entry point. It accepts only
descriptor-backed public plugins and validates the descriptor and manifest
before mutating registry state.

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

The host should reject unsupported API versions before evaluating plugin code.

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
directly. The host invocation layer verifies that operations return Effects,
wraps provider failures in typed host errors, validates result status/messages,
keeps interactive timeouts opt-in, and snapshots results before command code
uses them.

## Operation Boundary

Plugin operations are invoked through host-owned boundary helpers, not by
calling untrusted provider functions directly from command code.

The auth and pull-request provider runners are currently separate
implementations of the same pattern:

- catch synchronous operation throws
- reject non-Effect returns
- wrap provider failures in typed host errors
- apply explicit timeout policy only where appropriate
- validate result shape against the host contract
- freeze/snapshot request or result data before crossing the boundary

They remain separate for now because auth has interactive prompt semantics and
pull-request operations are non-interactive. If a third provider family needs
the same mechanics, factor the common invocation core at that point rather than
forcing auth prompts through a generic non-interactive abstraction.

## Host Services

Plugins that need host-mediated operations should use `AideHostServicesTag`.
The current mediated services are:

- auth provider discovery
- prime contribution discovery
- pull request provider discovery and resolution

- resolve provider for a git remote
- resolve provider for a pull request URL
- list pull requests for a remote
- get a pull request for a remote
- find a pull request for a branch
- get a pull request from a URL

Plugins do not receive the mutable registry through host services.
