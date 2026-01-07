# aide CLI - AI Agent Tools

A unified command-line tool designed for AI coding agents (like Claude Code) to interact with Jira and Azure DevOps APIs.

## Installation

### Option 1: Download Binary

Download the pre-built binary for your platform from the releases page and add it to your PATH:

- `aide.exe` - Windows
- `aide-linux` - Linux
- `aide-mac` - macOS (ARM)

### Option 2: Build from Source

```bash
git clone <repository>
cd agent-plugin
bun install
bun run build       # Current platform
# or
bun run build:win   # Windows
bun run build:linux # Linux
bun run build:mac   # macOS ARM
bun run build:all   # All platforms
```

Binaries are output to the `dist/` directory.

### Option 3: Run with Bun (Development)

```bash
bun run dev <command>
```

## Quick Start

```bash
# Get help
aide --help
aide jira --help
aide ado --help

# Search Jira tickets
aide jira search "assignee = currentUser()"
aide jira ticket PROJ-123

# List Azure DevOps PRs
aide ado prs --status active
aide ado comments 24094 --latest 5
```

## Command Structure

```
aide <service> <action> [options]
```

### Services

| Service | Description                |
| ------- | -------------------------- |
| `jira`  | Jira ticket management     |
| `ado`   | Azure DevOps pull requests |

### Jira Commands

| Command                          | Description              |
| -------------------------------- | ------------------------ |
| `aide jira search <jql>`         | Search tickets using JQL |
| `aide jira ticket <key>`         | Get ticket details       |
| `aide jira comment <key> <text>` | Add comment to ticket    |
| `aide jira comments <key>`       | Get ticket comments      |
| `aide jira desc <key> <text>`    | Set ticket description   |

### Azure DevOps Commands

| Command                     | Description        |
| --------------------------- | ------------------ |
| `aide ado prs`              | List pull requests |
| `aide ado comments <pr-id>` | Get PR comments    |

## Usage Examples

### Jira

```bash
# Search for your tickets
aide jira search "assignee = currentUser()"

# Get ticket details
aide jira ticket PROJ-123

# Add a comment
aide jira comment PROJ-123 "Work completed"

# Get recent comments
aide jira comments PROJ-123 --latest 5

# Update description
aide jira desc PROJ-123 "New description text"
```

### Azure DevOps

```bash
# List active PRs (auto-discovers project from git remote)
aide ado prs

# List PRs with filters
aide ado prs --status completed --limit 10
aide ado prs --created-by "your.email@company.com"

# Get PR comments
aide ado comments 24094
aide ado comments 24094 --latest 5 --format json
```

### Output Formats

All commands support `--format` flag:

- `text` - Human-readable (default)
- `json` - Structured data for AI/script processing
- `markdown` - Documentation-friendly format

```bash
aide jira search "status = Open" --format json
aide ado comments 24094 --format markdown
```

## Configuration

### Environment Variables

**Jira:**

```bash
export JIRA_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="your-email@company.com"
export JIRA_API_TOKEN="your-api-token-here"
```

**Azure DevOps:**

```bash
export AZURE_DEVOPS_ORG_URL="https://dev.azure.com/yourorg"
export AZURE_DEVOPS_PAT="your-personal-access-token"
```

You can store these in:

- `~/.vars` and source it in your shell profile
- A `.env` file in your project directory (automatically loaded by Bun)

## Auto-Discovery

When running from within a git repository with an Azure DevOps remote, ADO commands automatically detect:

- Organization
- Project
- Repository

Supported remote formats:

- SSH: `git@ssh.dev.azure.com:v3/org/project/repo`
- HTTPS: `https://dev.azure.com/org/project/_git/repo`

## Development

### Prerequisites

- [Bun](https://bun.sh/) runtime

### Setup

```bash
bun install
```

### Running

```bash
bun run dev --help
bun run dev jira search "assignee = currentUser()"
```

### Building

```bash
bun run build       # Current platform
bun run build:all   # All platforms
```

### Linting

```bash
bun run lint        # Check for issues
bun run lint:fix    # Auto-fix issues
bun run format      # Format code
```

## Claude Code Plugin

This repository includes a Claude Code plugin for AI agent integration with Jira and Azure DevOps.

### Installing the Plugin

The aide CLI can install its own Claude Code plugin:

```bash
# Build the CLI first
bun run build

# Install plugin globally (recommended)
aide plugin install

# Or install to current project only
aide plugin install --project

# Check installation status
aide plugin status

# Remove plugin
aide plugin uninstall
```

### Installation Scopes

| Scope   | Flag               | Location                  | Use Case                     |
| ------- | ------------------ | ------------------------- | ---------------------------- |
| User    | `--user` (default) | `~/.claude/plugins/aide/` | Personal, all projects       |
| Project | `--project`        | `.claude/plugins/aide/`   | Team-shared via git          |
| Local   | `--local`          | `.claude/plugins/aide/`   | Project-specific, gitignored |

### Available Slash Commands

After installation, these commands are available in Claude Code:

| Command                    | Description                 |
| -------------------------- | --------------------------- |
| `/aide:ticket KEY`         | Load Jira ticket context    |
| `/aide:search "JQL"`       | Search Jira tickets         |
| `/aide:comment KEY "text"` | Add comment to ticket       |
| `/aide:update KEY`         | Update ticket description   |
| `/aide:pr PR-ID`           | Load PR comments for review |

### Workflows

**Ticket-Driven Development:**

1. `/aide:ticket PROJ-123` - Load ticket context
2. Implement the feature/fix
3. `/aide:comment PROJ-123 "Implemented X, Y, Z"` - Update ticket

**PR Review:**

1. `/aide:pr 24094 --thread-status active` - Load active feedback
2. Address each comment
3. Push changes

## License

MIT
