# Plugin API Boundary

This document defines the boundary that must hold before `aide add {plugin}` or
runtime external plugin loading exists.

## Public API

Plugin authors should import from `@aide/plugin-api`. The public API is the
small author-facing surface for:

- command descriptors and command results
- plugin descriptors and descriptor-backed command placement
- auth capability status contracts
- pull request provider refs, matches, features, and operations
- mediated host services through `AideHostServicesTag`
- manifest, trust, capability, and conflict policy metadata

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
- `conflicts.commands` and `conflicts.pullRequestProviders` currently support
  only `reject`.

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

Core providers are host-owned. External providers can still represent their own
repository refs through `kind: "external"` with their own provider id.

## Host Services

Plugins that need host-mediated operations should use `AideHostServicesTag`.
The current mediated services are pull request provider resolution and pull
request operations:

- resolve provider for a git remote
- resolve provider for a pull request URL
- list pull requests for a remote
- get a pull request for a remote
- find a pull request for a branch
- get a pull request from a URL

Plugins do not receive the mutable registry through host services.
