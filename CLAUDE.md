# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **aide CLI** - a unified command-line tool for AI coding agents to interact with Jira, Azure DevOps, and GitHub APIs. Built with Bun/TypeScript, it provides a single binary that can be compiled for Windows, Linux, and macOS.

The CLI follows a hierarchical command structure: `aide <service> <action> [options]`

**Services:**

- `jira` - Jira ticket management (search, view, create, update, transition, comment, comments, delete-comment, edit-comment, attach, fields, boards, sprint, api)
- `pr` - Pull request management (list, view, diff, create, update, comments, comment, reply)
- `plugin` - Claude Code plugin management (install, status, uninstall)

**Top-level Commands:**

- `prime` - Output aide context for session start hook
- `upgrade` - Upgrade aide to the latest version
- `login` - Save credentials to OS keyring (`aide login <jira|ado|github>`)
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
bun run lint              # Run ESLint
bun run lint:fix          # Auto-fix linting issues
bun run format            # Format with Prettier
bun run format:check      # Check formatting
bunx tsc --noEmit         # Type check without emitting
```

## Architecture

### Directory Structure

```
src/
  cli/                    # CLI implementation
    index.ts              # Main entry point, top-level yargs wiring
    help.ts               # VERSION constant and CLI_NAME
    update.ts             # Upgrade/cleanup helpers
    commands/
      jira/               # Jira service commands
      pr/                 # Pull request service commands
      plugin/             # Plugin management commands
      login.ts            # aide login <service>
      logout.ts           # aide logout <service>
      whoami.ts           # aide whoami
      prime.ts            # aide prime
      upgrade.ts          # aide upgrade
  lib/                    # Shared libraries
    config.ts             # Config loading; probeJiraConfig, probeAdoConfig, probeGithubConfig
    jira-client.ts        # Jira REST API client
    azure-devops-client.ts # Azure DevOps REST API client
    github-client.ts      # GitHub REST API client (via gh CLI or GITHUB_TOKEN)
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
    errors.ts             # handleCommandError, UserCancelledError
    prompts.ts            # Interactive prompt helpers (text, password, confirm)
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

Commands are **yargs `CommandModule` objects** with four fields: `command` (the name/positionals), `describe` (help text), `builder` (option/positional definitions via the yargs fluent API), and `handler` (async function that does the work).

Services (`jira`, `pr`, `plugin`) each expose their own `CommandModule` in `src/cli/commands/<service>/index.ts`. The builder for a service module chains `.command(subcommand)` calls to compose all subcommands, then calls `.demandCommand(1, ...)` to require a subcommand.

The top-level `main()` in `src/cli/index.ts` registers every service and top-level command via `.command(...)`, then calls `.parse()`. Errors are thrown; `main()` catches them and prints via `handleCommandError` in `@lib/errors.ts`, exiting 1 (or 130 for `UserCancelledError`).

**Auto-Discovery:**
PR commands automatically discover organization, project, and repository from git remote URLs:

- Azure DevOps SSH: `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
- Azure DevOps HTTPS: `https://dev.azure.com/{org}/{project}/_git/{repo}`
- GitHub SSH: `git@github.com:{owner}/{repo}.git`
- GitHub HTTPS: `https://github.com/{owner}/{repo}.git`

**Multiple Output Formats:**
All commands support `--format` flag:

- `text` - Human-readable (default)
- `json` - Structured data for AI/script processing
- `markdown` - Documentation-friendly format

## Adding New Commands

### Adding a Command to an Existing Service

1. **Create the command file** (e.g., `src/cli/commands/jira/new-cmd.ts`):

```typescript
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

interface NewCmdArgs {
  ticket?: string;
  verbose?: boolean;
}

const command: CommandModule<{}, NewCmdArgs> = {
  command: 'new-cmd [ticket]',
  describe: 'Short description shown in help',
  builder: (yargs) =>
    yargs
      .positional('ticket', {
        type: 'string',
        describe: 'Ticket ID',
      })
      .option('verbose', {
        type: 'boolean',
        describe: 'Verbose output',
        default: false,
      }),
  handler: async (argv: ArgumentsCamelCase<NewCmdArgs>) => {
    // Implementation - throw on error, don't call process.exit
    // Use shared helpers from @lib/cli-utils.ts for progress/formatting
  },
};

export default command;
```

2. **Register in the service index** (`src/cli/commands/jira/index.ts`) by adding `.command(newCmdCommand)` to the builder chain.

### Adding a New Service

1. Create a new directory: `src/cli/commands/myservice/`
2. Create the index (`index.ts`) as a `CommandModule` that composes subcommands in its builder
3. Create command files for each action
4. Register the service in `src/cli/index.ts` via `.command(myserviceCommands)`

## Important Implementation Notes

**Jira ADF Conversion:**
Jira uses Atlassian Document Format (ADF) for rich text. The conversion utilities handle bidirectional conversion. Always convert ADF to markdown for readability when displaying content.

**Azure DevOps API Versions:**
Use API version `7.2-preview.1` for Azure DevOps endpoints. The preview version is required for PR threads/comments endpoints.

**Error Handling:**
Commands throw errors rather than calling `process.exit`. The top-level `main()` in `src/cli/index.ts` catches errors and prints them, then exits with code 1. `UserCancelledError` exits with code 130 (silent). Use `handleCommandError` from `@lib/errors.ts` inside individual command handlers.

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

Use `aide login <service>` to store credentials in the OS keyring (macOS Keychain, Windows Credential Manager, or libsecret on Linux):

    aide login jira     # prompts for URL, email, API token
    aide login ado      # prompts for org URL, PAT
    aide login github   # stores token if gh CLI is unavailable

To migrate existing env var credentials into the keyring without retyping, pass `--from-env`:

    aide login jira --from-env
    aide login ado --from-env
    aide login github --from-env

Check what's configured with `aide whoami` (prints a hint when any service is sourced from env). Remove with `aide logout <service>`.

### Environment Variables (Fallback)

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

GitHub authentication is handled automatically via the `gh` CLI. If you have `gh` installed and authenticated (`gh auth login`), no additional configuration is needed.

For CI/headless environments without `gh`, set:

```bash
export GITHUB_TOKEN="your-github-token"
```

The platform is auto-detected from the git remote URL. GitHub remotes (SSH or HTTPS) are automatically recognized.

Credentials can be stored in `~/.vars` and sourced, or in a `.env` file in the project directory.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
