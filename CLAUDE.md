# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **aide CLI** - a unified command-line tool for AI coding agents to interact with Jira, Azure DevOps, and GitHub APIs. Built with Bun/TypeScript, it provides a single binary that can be compiled for Windows, Linux, and macOS.

The CLI follows a hierarchical command structure: `aide <service> <action> [options]`

**Services:**

- `jira` - Jira ticket management (search, view, create, update, transition, comment, comments, delete-comment, edit-comment, attach, fields, boards, sprint)
- `pr` - Pull request management (list, view, diff, create, update, comments, comment, reply)
- `plugin` - Claude Code plugin management (install, status, uninstall)

**Top-level Commands:**

- `prime` - Output aide context for session start hook
- `upgrade` - Upgrade aide to the latest version
- `login` - Configure provider authentication; stored-credential flows use the OS keyring (`aide login <jira|ado|github>`)
- `logout` - Remove stored credentials (`aide logout <service>`)
- `whoami` - Show configured credentials and their source

## Development Commands

### Setup

```bash
bun install
```

### Running the CLI (Development)

```bash
# Using the dev script
bun run dev --help
bun run dev jira search "assignee = currentUser()"
bun run dev jira view PROJ-123
bun run dev pr list --status active
bun run dev pr comments --pr 24094 --latest 5

# Direct execution
bun run src/cli/index.ts --help
```

### Plugin Installation

```bash
# Install plugin (requires Claude CLI in PATH)
aide plugin install              # Install for current user (default)
aide plugin install --project    # Install to project scope
aide plugin install --local      # Install to local scope

# Check status and manage
aide plugin status
aide plugin uninstall --user
```

Or install manually from within Claude Code:

```bash
/plugin marketplace add rlcurrall/aide
/plugin install aide@aide-marketplace
```

### Building Binaries

```bash
bun run build           # Current platform
bun run build:win       # Windows (aide.exe)
bun run build:linux     # Linux (aide-linux)
bun run build:mac       # macOS ARM (aide-mac)
bun run build:all       # All platforms
```

Binaries are output to the `dist/` directory.

### Linting, Formatting, and Type Checking

```bash
bun run lint              # Run Oxlint
bun run lint:fix          # Auto-fix linting issues
bun run format            # Format with Oxfmt
bun run format:check      # Check formatting
bunx tsc --noEmit         # Type check without emitting
```

## Architecture

### Directory Structure

```
src/
  cli/                    # CLI implementation
    index.ts              # Composition root; registry-to-yargs handoff
    help.ts               # VERSION constant and CLI_NAME
    update.ts             # Upgrade/cleanup helpers
    host/
      command-descriptor.ts # Internal Effect command descriptors
      plugin-descriptor.ts  # Built-in plugin and capability descriptors
      command-registry.ts   # CommandRegistry ownership and registration
      runtime-context.ts    # Runtime service composition
      yargs-adapter.ts      # Current parser/execution adapter
    plugins/
      builtin.ts          # Built-in plugin registration list
      aide-core/          # Core descriptor and Prime implementation
      pull-requests/      # PR descriptor and owned command implementations
      jira/               # Jira descriptor, auth-provider/discovery, Prime contribution, and legacy-group registration
      azure-devops/       # Azure DevOps auth and PR provider implementation
      github/             # GitHub auth, discovery, and PR provider implementation
      claude-code/        # Claude Code plugin-management descriptor
      legacy-auth/        # Login, logout, and whoami descriptor ownership
    commands/
      jira/               # Legacy Jira ticket-command implementations
      plugin/             # Remaining legacy plugin-management modules
      pr/                 # Compatibility re-exports for plugin-owned PR commands
      login.ts            # Legacy host-aware aide login module
      logout.ts           # Legacy host-aware aide logout module
      whoami.ts           # Whoami descriptor plus yargs compatibility export
      upgrade.ts          # Remaining legacy aide upgrade module
  lib/                    # Shared libraries
    config.ts             # Config loading; probeJiraConfig, probeAdoConfig, probeGithubConfig
    jira-client.ts        # Jira REST API client
    azure-devops-client.ts # Azure DevOps REST API client
    github-client.ts      # GitHub REST API client
    github-types.ts       # GitHub API response types
    github-utils.ts       # GitHub-specific URL parsing and helpers
    gh-utils.ts           # gh CLI availability check
    git-utils.ts          # Git remote URL utilities
    platform.ts           # Platform detection and context resolution
    adf-to-md.ts          # Atlassian Document Format to Markdown
    md-to-adf.ts          # Markdown to Atlassian Document Format
    ado-utils.ts          # Azure DevOps-specific utilities
    cli-utils.ts          # CLI formatting helpers (logProgress, etc.)
    comment-utils.ts      # Comment filtering utilities
    field-resolver.ts     # Jira custom field name-to-key resolution
    value-formatter.ts    # Auto-format field values by type
    jira-utils.ts         # Shared Jira command helpers
    validation.ts         # Argument validation via valibot schemas
    errors.ts             # Legacy handleCommandError helper
    prompts.ts            # Prompting helpers and UserCancelledError
    secrets.ts            # Bun.secrets wrapper for OS keyring credential storage
    types.ts              # TypeScript interfaces

  schemas/                # Valibot schemas for command arguments and config
    common.ts             # Shared schema primitives
    config.ts             # Stored credential schemas (StoredJiraSchema, etc.)
    jira/                 # Per-command schemas for jira subcommands
    pr/                   # Per-command schemas for pr subcommands

skills/                   # Claude Code skills (auto-discovered by Claude)
  pr-view/SKILL.md        # View PR details
  pr-diff/SKILL.md        # View PR diff and changed files
  pr-create/SKILL.md      # Create a PR
  pr-update/SKILL.md      # Update a PR
  pr-comments/SKILL.md    # Get PR comments
  pr-comment/SKILL.md     # Post comment on PR
  pr-reply/SKILL.md       # Reply to PR thread
  pr-list/SKILL.md        # List PRs
  ticket/SKILL.md         # Load Jira ticket context
  ticket-search/SKILL.md  # Search Jira tickets
  ticket-create/SKILL.md  # Create a Jira ticket
  ticket-update/SKILL.md  # Update ticket fields
  ticket-comment/SKILL.md # Add comment to ticket
  ticket-comments/SKILL.md # Get ticket comments
  ticket-transition/SKILL.md # Change ticket status
  ticket-fields/SKILL.md  # Discover available fields
  ticket-attach/SKILL.md  # Manage attachments
  ticket-delete-comment/SKILL.md # Delete a comment
  ticket-edit-comment/SKILL.md   # Edit a comment
  boards/SKILL.md         # List Jira boards
  sprint/SKILL.md         # Get sprint information

.claude-plugin/           # Claude Code plugin metadata
  plugin.json             # Plugin manifest
  marketplace.json        # Marketplace listing info
```

### Command Architecture

The command architecture is hybrid. Built-in plugin descriptors in `src/cli/plugins/*` declare command ownership and capabilities. `src/cli/plugins/builtin.ts` registers them with the internal `CommandRegistry` in `src/cli/host/command-registry.ts`. The pull-requests plugin owns the PR command group and implementations; the aide-core plugin owns the Prime descriptor. Remaining legacy yargs `CommandModule`s, including Jira and plugin management, still live under `src/cli/commands` and are registered by their owning built-in plugins.

`src/cli/host/command-descriptor.ts` and `plugin-descriptor.ts` define the internal descriptor model, while `runtime-context.ts` composes host services. yargs remains the current parser adapter at `src/cli/host/yargs-adapter.ts`: it turns descriptors into yargs modules, supplies Effect services at execution, wraps remaining legacy modules with host context, and registers the registry entries at the yargs boundary.

The top-level `main()` in `src/cli/index.ts` creates the built-in registry and live layers, passes them to `registerCommands`, and owns the yargs usage and final error boundary. Descriptor commands run as Effects through the adapter; legacy yargs handlers remain supported, so do not assume every command is Effect-native. Descriptor and new command implementations should propagate failures or throw rather than call `process.exit`. Existing legacy and plugin-local yargs handlers may still render errors and exit through local helpers. yargs `.fail` owns parser/usage failures; the top-level catch owns propagated failures and cancellation, preserving silent exit 130 for `UserCancelledError`.

**Auto-Discovery:**
PR commands automatically discover organization, project, and repository from git remote URLs:

- Azure DevOps SSH: `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
- Azure DevOps HTTPS: `https://dev.azure.com/{org}/{project}/_git/{repo}`
- GitHub SSH: `git@github.com:{owner}/{repo}.git`
- GitHub HTTPS: `https://github.com/{owner}/{repo}.git`
- GitHub Enterprise Cloud (data residency) SSH: `git@{subdomain}.ghe.com:{owner}/{repo}.git`
- GitHub Enterprise Cloud (data residency) HTTPS: `https://{subdomain}.ghe.com/{owner}/{repo}.git`

For GHE Cloud hosts the REST/GraphQL API base is derived as `https://api.{subdomain}.ghe.com`, and the `gh` CLI transport passes `--hostname {subdomain}.ghe.com`. Self-hosted GitHub Enterprise Server (`/api/v3` hosts) is not supported.

**Multiple Output Formats:**
Most data-oriented commands accept a `--format` flag:

- `text` - Human-readable (default)
- `json` - Structured data for AI/script processing
- `markdown` - Documentation-friendly format

## Adding New Commands

### Extending an Existing Built-in Plugin

1. Find the owning descriptor under `src/cli/plugins/*/plugin.ts`. Keep descriptor and plugin-local implementations with that plugin: PR commands belong under `src/cli/plugins/pull-requests/`, and Prime belongs under `src/cli/plugins/aide-core/`. For intentionally legacy Jira, plugin-management, auth, or upgrade work, follow the next section and retain existing `src/cli/commands` ownership where applicable.
2. Prefer the established internal descriptor path (`defineAideCommand` plus `pluginCommandDescriptor`) and the owning plugin's Effect operation/service patterns. Where an owned surface still uses plugin-local yargs modules, such as PR commands, follow that existing pattern and declare them with `pluginCommandModule`.
3. Add the command to the owning plugin's `commands` array. A child command gets `parentId`; an ordinary leaf gets no extension policy. A command that itself accepts children gets `acceptsChildren` and its own `extension` policy. `CommandRegistry` validates ownership and routes; `yargs-adapter.ts` performs parser registration.
4. Add focused descriptor/registry/runtime tests and command behavior tests beside the owning implementation.

### Intentionally Legacy Commands

Use `src/cli/commands` and a yargs `CommandModule` only when extending an intentionally legacy surface, including existing Jira, plugin-management, auth, and upgrade implementations. Register the module through the owning built-in plugin descriptor with `pluginCommandModule`; do not add direct top-level `.command(...)` wiring in `src/cli/index.ts`.

### Adding a New Built-in Service

Create its descriptor and implementation under `src/cli/plugins/<service>/`, expose commands and capabilities from that descriptor, and add the plugin to `src/cli/plugins/builtin.ts`. Reuse the established Effect operation/service boundaries and host tests for comparable built-ins.

## Important Implementation Notes

**Jira ADF Conversion:**
Jira uses Atlassian Document Format (ADF) for rich text. The conversion utilities handle bidirectional conversion. Always convert ADF to markdown for readability when displaying content.

**Azure DevOps API Versions:**
Azure DevOps API versions are endpoint-specific. Before changing or adding a call, check the version used by the current client and the endpoint's API contract, and preserve that version unless the contract requires a change.

**Error Handling:**
Descriptor commands return Effects that the yargs adapter executes with their declared services. Remaining legacy handlers run through the legacy yargs bridge and may use established helpers such as `src/cli/commands/effect-bridge.ts` for Effect operations. Descriptor and new command implementations should propagate failures or throw rather than call `process.exit`; existing legacy and plugin-local yargs handlers may still render errors and exit through local helpers. yargs `.fail` owns parser/usage failures; the top-level catch owns propagated failures and cancellation. `UserCancelledError` exits silently with code 130.

**Git Remote Detection:**
PR commands use `spawnSync(['git', 'config', '--get', 'remote.origin.url'])` to detect repository context and auto-route to the appropriate platform (Azure DevOps or GitHub).

**Custom Field Handling:**
The `--field` flag on create/update commands supports:

- **Name resolution**: Use human-readable field names (e.g., "Severity") instead of internal IDs (e.g., "customfield_10269")
- **Auto-formatting**: Values are automatically formatted based on field type (select fields get `{value: "..."}`, etc.)
- **Validation**: Invalid values show helpful error messages with the list of allowed values
- **Discovery**: Use `aide jira fields PROJECT -t IssueType --show-values` to discover available fields

**Description Format:**
Descriptions should be written in Markdown format. The CLI automatically converts Markdown to Jira's Atlassian Document Format (ADF). If Jira wiki syntax is detected (e.g., `h2.`, `{code}`, `{{inline}}`), a warning is shown with conversion suggestions.

## Configuration Requirements

### Interactive Setup (Recommended)

Use `aide login <service>` to configure provider authentication. Stored credentials use the OS keyring (macOS Keychain, Windows Credential Manager, or libsecret on Linux):

    aide login jira     # prompts for URL, email, API token
    aide login ado      # prompts for org URL, PAT
    aide login github   # uses eligible gh auth or stores a requested-host token

To migrate existing env var credentials into the keyring without retyping, pass `--from-env`:

    aide login jira --from-env
    aide login ado --from-env
    aide login github --from-env

Check what's configured with `aide whoami` (prints a hint when any service is sourced from env). Remove with `aide logout <service>`.

### Environment Variables and Provider Resolution

Credential resolution and account discovery are provider- and scope-specific; there is no universal keyring-first or environment-fallback rule. Jira and Azure DevOps config probes accept a complete matching environment configuration before stored credentials. Exact GitHub resolution considers the requested host/account across the `gh` CLI, eligible host-bound environment credentials, and the selected stored credential. Omitted-scope account discovery separately assembles each provider's eligible environment and stored accounts, plus GitHub's bounded `gh` account catalog. Scoped stored credentials use the auth store/keyring.

See `src/lib/config.ts`, `src/lib/github-credential-resolver.ts`, `src/cli/plugins/builtin-auth-provider-discovery.ts`, and `src/cli/plugins/github/auth-discovery.ts` before changing credential behavior.

#### Jira

```bash
export JIRA_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="your-email@company.com"
export JIRA_API_TOKEN="your-api-token-here"
```

#### Azure DevOps

```bash
export AZURE_DEVOPS_ORG_URL="https://dev.azure.com/yourorg"
export AZURE_DEVOPS_PAT="your-personal-access-token"
export AZURE_DEVOPS_AUTH_METHOD="pat"  # optional, default: pat
```

#### GitHub

GitHub can use an authenticated `gh` CLI account for the requested host/account. Eligible environment or scoped stored credentials participate according to the exact resolver described above.

For CI/headless environments without `gh`, set:

```bash
export GITHUB_TOKEN="your-github-token"
```

The platform is auto-detected from the git remote URL. GitHub remotes (SSH or HTTPS) are automatically recognized.

Credentials can be stored in `~/.vars` and sourced, or in a `.env` file in the project directory.
