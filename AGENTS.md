# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **aide CLI** - a unified command-line tool for AI coding agents to interact with Jira and Azure DevOps APIs. Built with Bun/TypeScript, it provides a single binary that can be compiled for Windows, Linux, and macOS.

The CLI follows a hierarchical command structure: `aide <service> <action> [options]`

**Services:**

- `jira` - Jira ticket management (search, ticket, comment, comments, desc)
- `pr` - Pull request management (list, create, update, comments, comment, reply)
- `plugin` - Claude Code plugin management (install, uninstall, status)

**Top-level Commands:**

- `prime` - Output aide context for session start hook
- `upgrade` - Upgrade aide to the latest version

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
bun run dev jira ticket PROJ-123
bun run dev pr list --status active
bun run dev pr comments --pr 24094 --latest 5

# Direct execution
bun run src/cli/index.ts --help
```

### Plugin Management

```bash
# Install plugin (user scope, all projects)
bun run dev plugin install --user

# Install to current project only (committed to git)
bun run dev plugin install --project

# Install to current project (gitignored)
bun run dev plugin install --local

# Check installation status
bun run dev plugin status

# Remove plugin
bun run dev plugin uninstall --user
```

Installation scopes:

- `--user` (default): `~/.claude/plugins/aide/` - Personal, available in all projects
- `--project`: `.claude/plugins/aide/` - Team-shared via git
- `--local`: `.claude/plugins/aide/` - Project-specific, gitignored

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
    index.ts              # Main entry point, service routing
    parser.ts             # Command line parsing (parseArgs, CommandContext type)
    help.ts               # Help text generation utilities
    commands/
      types.ts            # Command and ServiceRouter interfaces
      jira/               # Jira service commands
      pr/                 # Pull request commands (Azure DevOps/GitHub)
      plugin/             # Plugin management commands
      prime.ts            # Prime command
      upgrade.ts          # Upgrade command
  lib/                    # Shared libraries
    config.ts             # Configuration loading from env vars
    jira-client.ts        # Jira REST API client
    azure-devops-client.ts # Azure DevOps REST API client
    adf-to-md.ts          # Atlassian Document Format to Markdown
    md-to-adf.ts          # Markdown to Atlassian Document Format
    ado-utils.ts          # Git remote URL parsing
    cli-utils.ts          # CLI formatting helpers
    comment-utils.ts      # Comment filtering utilities
    embedded-plugin.ts    # Embedded plugin files for installation
    types.ts              # TypeScript interfaces

commands/                 # Claude Code slash commands (for plugin)
  ticket.md               # /aide:ticket - Load Jira ticket context
  ticket-search.md        # /aide:ticket-search - Search Jira tickets
  ticket-comment.md       # /aide:ticket-comment - Add comment to ticket
  ticket-update.md        # /aide:ticket-update - Update ticket description
  pr-comments.md          # /aide:pr-comments - Get PR comments
  pr-comment.md           # /aide:pr-comment - Post comment on PR
  pr-create.md            # /aide:pr-create - Create a PR
  pr-update.md            # /aide:pr-update - Update a PR
  pr-reply.md             # /aide:pr-reply - Reply to PR thread

skills/aide/SKILL.md      # Claude Code skill definition

.claude-plugin/           # Claude Code plugin metadata
  plugin.json             # Plugin manifest
  marketplace.json        # Marketplace listing info
```

### Command Architecture

Each service has a **router** that implements the `ServiceRouter` interface:

- Routes actions to appropriate command handlers
- Displays service-level help
- Handles unknown commands gracefully

Each command implements the `Command` interface:

- `name` - Command name
- `description` - Short description for help text
- `execute(ctx: CommandContext)` - Main execution function
- Returns exit code (0 = success, 1 = error)

### Key Design Patterns

**Service Routing:**
The main entry point (`cli/index.ts`) parses the command line and routes to service routers, which then route to individual commands.

**Auto-Discovery:**
Azure DevOps commands automatically discover organization, project, and repository from git remote URLs:

- SSH format: `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
- HTTPS format: `https://dev.azure.com/{org}/{project}/_git/{repo}`

**Multiple Output Formats:**
All commands support `--format` flag:

- `text` - Human-readable (default)
- `json` - Structured data for AI/script processing
- `markdown` - Documentation-friendly format

**Environment Configuration:**
Credentials are loaded from environment variables:

- Jira: `JIRA_URL`, `JIRA_EMAIL`/`JIRA_USERNAME`, `JIRA_API_TOKEN`/`JIRA_TOKEN`
- Azure DevOps: `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_AUTH_METHOD`

Bun automatically loads `.env` files from the working directory.

## Adding New Commands

### Adding a Command to an Existing Service

1. **Create the command file** (e.g., `src/cli/commands/jira/new-cmd.ts`):

```typescript
import type { Command, CommandContext } from '../types.js';
import { formatCommandHelp } from '../../help.js';

export const newCmdCommand: Command = {
  name: 'new-cmd',
  description: 'Short description of the command',

  async execute(ctx: CommandContext): Promise<number> {
    // Handle --help flag
    if (ctx.flags.has('help')) {
      console.log(
        formatCommandHelp({
          name: 'jira new-cmd',
          description: 'Detailed description',
          usage: 'jira new-cmd <args> [options]',
          arguments: [{ name: 'arg', description: 'Argument description' }],
          flags: [{ name: '--flag', description: 'Flag description' }],
          examples: ['jira new-cmd example1', 'jira new-cmd example2 --flag'],
        })
      );
      return 0;
    }

    // Command implementation
    try {
      // ... your logic here
      return 0;
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  },
};
```

2. **Register in the service router** (`src/cli/commands/jira/index.ts`):

```typescript
import { newCmdCommand } from './new-cmd.js';

const commands: Map<string, Command> = new Map([
  // ... existing commands
  ['new-cmd', newCmdCommand],
]);
```

### Adding a New Service

1. Create a new directory: `src/cli/commands/myservice/`
2. Create the router (`index.ts`) implementing `ServiceRouter`
3. Create command files for each action
4. Register the service in `src/cli/index.ts`

## Important Implementation Notes

**Jira ADF Conversion:**
Jira uses Atlassian Document Format (ADF) for rich text. The conversion utilities handle bidirectional conversion. Always convert ADF to markdown for readability when displaying content.

**Azure DevOps API Versions:**
Use API version `7.2-preview.1` for Azure DevOps endpoints. The preview version is required for PR threads/comments endpoints.

**Error Handling:**
Commands exit with status code 1 on errors and print user-friendly error messages to stderr. Configuration errors provide specific guidance on missing environment variables.

**Git Remote Detection:**
Azure DevOps commands use `spawnSync(['git', 'config', '--get', 'remote.origin.url'])` to detect repository context.

## Configuration Requirements

### Jira

```bash
export JIRA_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="your-email@company.com"
export JIRA_API_TOKEN="your-api-token-here"
```

### Azure DevOps

```bash
export AZURE_DEVOPS_ORG_URL="https://dev.azure.com/yourorg"
export AZURE_DEVOPS_PAT="your-personal-access-token"
export AZURE_DEVOPS_AUTH_METHOD="pat"  # optional, default: pat
```

Credentials can be stored in `~/.vars` and sourced, or in a `.env` file in the project directory.
