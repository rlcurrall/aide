# aide CLI - AI Agent Tools

A unified command-line tool designed for AI coding agents (like Claude Code) to interact with Jira and Azure DevOps APIs.

## Installation

### Option 1: Quick Install (Recommended)

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/rlcurrall/aide/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/rlcurrall/aide/main/install.ps1 | iex
```

**Windows (Git Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/rlcurrall/aide/main/install.sh | bash
```

The installation scripts will:
- Download the latest release for your platform
- Install to `~/.local/bin` (Linux/macOS) or `%LOCALAPPDATA%\Programs\aide` (Windows)
- Add the installation directory to your PATH (Windows only)

### Option 2: Manual Download

Download the pre-built binary for your platform from the [releases page](https://github.com/rlcurrall/aide/releases/latest):

**Linux:**
```bash
curl -fsSL https://github.com/rlcurrall/aide/releases/latest/download/aide-linux -o aide
chmod +x aide
sudo mv aide /usr/local/bin/
```

**macOS:**
```bash
curl -fsSL https://github.com/rlcurrall/aide/releases/latest/download/aide-mac -o aide
chmod +x aide
sudo mv aide /usr/local/bin/
```

**Windows (PowerShell):**
```powershell
Invoke-WebRequest -Uri "https://github.com/rlcurrall/aide/releases/latest/download/aide.exe" -OutFile "aide.exe"
# Move aide.exe to a directory in your PATH
```

### Option 3: Build from Source

```bash
git clone https://github.com/rlcurrall/aide.git
cd aide
bun install
bun run build       # Current platform
# or
bun run build:win   # Windows
bun run build:linux # Linux
bun run build:mac   # macOS ARM
bun run build:all   # All platforms
```

Binaries are output to the `dist/` directory.

### Option 4: Run with Bun (Development)

```bash
bun run dev <command>
```

## Quick Start

```bash
# Get help
aide --help
aide jira --help
aide pr --help

# Search Jira tickets
aide jira search "assignee = currentUser()"
aide jira ticket PROJ-123

# List pull requests
aide pr list --status active
aide pr comments --pr 24094 --latest 5
```

## Command Structure

```
aide <service> <action> [options]
```

### Services

| Service  | Description                |
| -------- | -------------------------- |
| `jira`   | Jira ticket management     |
| `pr`     | Pull request management    |
| `plugin` | Claude Code plugin manager |
| `prime`  | Output aide context        |
| `upgrade`| Upgrade aide to latest     |

### Jira Commands

| Command                          | Description              |
| -------------------------------- | ------------------------ |
| `aide jira search <jql>`         | Search tickets using JQL |
| `aide jira ticket <key>`         | Get ticket details       |
| `aide jira comment <key> <text>` | Add comment to ticket    |
| `aide jira comments <key>`       | Get ticket comments      |
| `aide jira desc <key> <text>`    | Set ticket description   |

### Pull Request Commands

| Command                                  | Description                    |
| ---------------------------------------- | ------------------------------ |
| `aide pr list`                            | List pull requests             |
| `aide pr view [--pr ID]`                 | View pull request details      |
| `aide pr diff [--pr ID]`                 | View PR diff and changed files |
| `aide pr create`                         | Create a pull request          |
| `aide pr update [--pr ID]`               | Update a pull request          |
| `aide pr comments [--pr ID]`             | Get PR comments                |
| `aide pr comment <text> [--pr ID]`       | Post a comment on a PR         |
| `aide pr reply <thread> <text> [--pr ID]`| Reply to a comment thread      |

Note: `--pr` flag is optional - aide auto-detects from current branch if omitted.

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

### Pull Requests

```bash
# List active PRs (auto-discovers project from git remote)
aide pr list

# List PRs with filters
aide pr list --status completed --limit 10
aide pr list --created-by "your.email@company.com"

# View PR details (--pr optional, auto-detects from current branch)
aide pr view --pr 24094
aide pr view  # auto-detect PR from branch

# View PR diff
aide pr diff --pr 24094           # full diff
aide pr diff --stat               # summary with file counts
aide pr diff --files              # list changed files only
aide pr diff --file src/app.ts   # diff for specific file

# Get PR comments (--pr optional, auto-detects from current branch)
aide pr comments --pr 24094
aide pr comments --pr 24094 --latest 5 --format json
aide pr comments --latest 10  # auto-detect PR from branch

# Create a PR
aide pr create --title "feat: add new feature" --base main

# Update a PR
aide pr update --pr 123 --title "Updated title"
aide pr update --publish  # publish draft PR (auto-detect)

# Post a comment
aide pr comment "LGTM, approved!" --pr 123
aide pr comment "Needs changes" --pr 123 --file src/app.ts --line 42

# Reply to a thread
aide pr reply 456 "Fixed the issue" --pr 123
```

### Output Formats

All commands support `--format` flag:

- `text` - Human-readable (default)
- `json` - Structured data for AI/script processing
- `markdown` - Documentation-friendly format

```bash
aide jira search "status = Open" --format json
aide pr comments --pr 24094 --format markdown
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

When running from within a git repository with an Azure DevOps remote, PR commands automatically detect:

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

**Option 1: Using aide CLI** (requires Claude CLI in PATH):

```bash
aide plugin install              # Install for current user
aide plugin install --project    # Install to project scope
aide plugin install --local      # Install to local scope
```

**Option 2: Using Claude Code directly**:

```bash
/plugin marketplace add rlcurrall/aide
/plugin install aide@aide-marketplace
```

### Installation Scopes

| Scope     | Flag        | Description                              |
| --------- | ----------- | ---------------------------------------- |
| User      | `--user`    | Personal installation, available in all projects (default) |
| Project   | `--project` | Team-shared via git, available to all collaborators |
| Local     | `--local`   | Project-specific, not shared (gitignored) |

### Managing the Plugin

```bash
aide plugin status               # Check installation status
aide plugin uninstall --user     # Remove from user scope
aide plugin uninstall --all      # Remove from all scopes
```

### Available Slash Commands

After installation, these commands are available in Claude Code:

**Jira Commands:**

| Command                            | Description                 |
| ---------------------------------- | --------------------------- |
| `/aide:ticket KEY`                 | Load Jira ticket context    |
| `/aide:ticket-search "JQL"`        | Search Jira tickets         |
| `/aide:ticket-comment KEY "text"`  | Add comment to ticket       |
| `/aide:ticket-update KEY`          | Update ticket description   |

**PR Commands:**

| Command                            | Description                 |
| ---------------------------------- | --------------------------- |
| `/aide:pr-view --pr ID`            | View PR details             |
| `/aide:pr-diff --pr ID`            | View PR diff                |
| `/aide:pr-comments --pr ID`        | Get PR comments             |
| `/aide:pr-comment "text" --pr ID`  | Post comment on PR          |
| `/aide:pr-create --title "..." `   | Create a pull request       |
| `/aide:pr-update --pr ID`          | Update a pull request       |
| `/aide:pr-reply THREAD "text"`     | Reply to PR thread          |

### Workflows

**Ticket-Driven Development:**

1. `/aide:ticket PROJ-123` - Load ticket context
2. Implement the feature/fix
3. `/aide:ticket-comment PROJ-123 "Implemented X, Y, Z"` - Update ticket

**PR Review:**

1. `/aide:pr-view --pr 24094` - View PR details
2. `/aide:pr-comments --pr 24094 --thread-status active` - Load active feedback
3. Address each comment
4. Push changes

## License

MIT
