# aide CLI - AI Agent Tools

A unified command-line tool designed for AI coding agents (like Claude Code) to interact with Jira, Azure DevOps, and GitHub APIs.

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
# Set up credentials (stores in OS keyring)
aide login jira     # prompts for Jira URL, email, API token
aide login ado      # prompts for Azure DevOps org URL and PAT
aide whoami         # show what's configured and where it came from

# Get help
aide --help
aide jira --help
aide pr --help

# Search Jira tickets
aide jira search "assignee = currentUser()"
aide jira view PROJ-123

# List pull requests
aide pr list --status active
aide pr comments --pr 24094 --latest 5
```

## Command Structure

```
aide <service> <action> [options]
```

### Services

| Service   | Description                 |
| --------- | --------------------------- |
| `jira`    | Jira ticket management      |
| `pr`      | Pull request management     |
| `plugin`  | Claude Code plugin manager  |
| `prime`   | Output aide context         |
| `upgrade` | Upgrade aide to latest      |
| `login`   | Save credentials to keyring |
| `logout`  | Remove stored credentials   |
| `whoami`  | Show credential sources     |

### Jira Commands

| Command                                     | Description                 |
| ------------------------------------------- | --------------------------- |
| `aide jira search <jql>`                    | Search tickets using JQL    |
| `aide jira view <key>`                      | Get ticket details          |
| `aide jira create -p PROJ -t Task -s "..."` | Create a ticket             |
| `aide jira update <key>`                    | Update ticket fields        |
| `aide jira transition <key> <status>`       | Change workflow status      |
| `aide jira comment <key> <text>`            | Add comment to ticket       |
| `aide jira comments <key>`                  | Get ticket comments         |
| `aide jira delete-comment <key> <id>`       | Delete a comment            |
| `aide jira edit-comment <key> <id> <text>`  | Edit a comment              |
| `aide jira attach <key>`                    | Manage attachments          |
| `aide jira fields <project>`                | Discover available fields   |
| `aide jira boards <project>`                | List boards for a project   |
| `aide jira sprint <board-id>`               | Get sprint info for a board |
| `aide jira api <endpoint>`                  | Call Jira REST API directly |

### Pull Request Commands

| Command                                   | Description                    |
| ----------------------------------------- | ------------------------------ |
| `aide pr list`                            | List pull requests             |
| `aide pr view [--pr ID]`                  | View pull request details      |
| `aide pr diff [--pr ID]`                  | View PR diff and changed files |
| `aide pr create`                          | Create a pull request          |
| `aide pr update [--pr ID]`                | Update a pull request          |
| `aide pr comments [--pr ID]`              | Get PR comments                |
| `aide pr comment <text> [--pr ID]`        | Post a comment on a PR         |
| `aide pr reply <thread> <text> [--pr ID]` | Reply to a comment thread      |

Note: `--pr` flag is optional - aide auto-detects from current branch if omitted.

## Usage Examples

### Jira

```bash
# Search for your tickets
aide jira search "assignee = currentUser()"

# Get ticket details
aide jira view PROJ-123

# Add a comment
aide jira comment PROJ-123 "Work completed"

# Get recent comments
aide jira comments PROJ-123 --latest 5

# Update description
aide jira update PROJ-123 --description "New description text"

# Call Jira REST API directly (for endpoints not covered by typed commands)
aide jira api /rest/api/3/statuses                              # GET request
aide jira api /rest/api/3/issues -X POST --input issue.json      # POST from file
aide jira api /rest/api/3/users/search -X POST < users.json      # POST from stdin
aide jira api /rest/api/3/projects/PROJ -f param=value          # String field parameter
aide jira api /rest/api/3/version -H "X-Custom-Header: value"    # Custom header
```

#### Raw API Passthrough

The `aide jira api <endpoint>` command mirrors the `gh api` workflow, letting you call any Jira REST API endpoint not covered by the typed `search`, `view`, `comment` commands and others.

Use this for endpoints that the typed commands don't support, custom queries, or direct field manipulation.

**Flags:**

- `-X, --method` - HTTP method (default: GET). Use `POST`, `PUT`, `DELETE`, etc.
- `-f` - String field parameter: `-f key=value` (can be repeated)
- `-F` - Typed field parameter: `-F key=@file` or `-F key=expression`
- `-H` - Custom header: `-H "Name: value"` (can be repeated)
- `--input` - Read request body from file or `-` for stdin

**Security:** Only HTTPS URLs on your configured Jira host are accepted. Absolute URLs are rejected; use relative paths like `/rest/api/3/...`.

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
aide pr diff --no-fetch           # skip auto-fetching branches

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

### Credential Storage (Keyring)

aide prefers the OS credential store (macOS Keychain, Windows Credential Manager, Linux libsecret) via `Bun.secrets`. Set up with:

```bash
aide login jira     # prompts for URL, email, API token
aide login ado      # prompts for org URL and PAT
aide login github   # no-op if gh CLI is authenticated
```

Run `aide whoami` to see what's configured and where it's coming from, and `aide logout <service>` to remove a stored entry.

If you already have credentials in environment variables and want to promote them into the keyring without retyping, use `--from-env`:

```bash
aide login jira --from-env     # reads JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN
aide login ado --from-env      # reads AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT
aide login github --from-env   # reads GITHUB_TOKEN (or GH_TOKEN)
```

Environment variables (below) remain supported and take precedence over the keyring. This is the recommended path for CI and other headless contexts.

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

**GitHub:**

GitHub authentication is handled automatically via the `gh` CLI. If you have `gh` installed and authenticated (`gh auth login`), no additional configuration is needed.

For CI/headless environments without `gh`, set:

```bash
export GITHUB_TOKEN="your-github-token"
```

You can store these in:

- `~/.vars` and source it in your shell profile
- A `.env` file in your project directory (automatically loaded by Bun)

## Auto-Discovery

When running from within a git repository, PR commands automatically detect the hosting platform and repository from the git remote.

**Azure DevOps:**

- SSH: `git@ssh.dev.azure.com:v3/org/project/repo`
- HTTPS: `https://dev.azure.com/org/project/_git/repo`

**GitHub:**

- SSH: `git@github.com:owner/repo.git`
- HTTPS: `https://github.com/owner/repo.git`

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

This repository includes a Claude Code plugin for AI agent integration with Jira, Azure DevOps, and GitHub.

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

| Scope   | Flag        | Description                                                |
| ------- | ----------- | ---------------------------------------------------------- |
| User    | `--user`    | Personal installation, available in all projects (default) |
| Project | `--project` | Team-shared via git, available to all collaborators        |
| Local   | `--local`   | Project-specific, not shared (gitignored)                  |

### Managing the Plugin

```bash
aide plugin status               # Check installation status
aide plugin uninstall --user     # Remove from user scope
aide plugin uninstall --all      # Remove from all scopes
```

### Available Slash Commands

After installation, these commands are available in Claude Code:

**Jira Commands:**

| Command                           | Description               |
| --------------------------------- | ------------------------- |
| `/aide:ticket KEY`                | Load Jira ticket context  |
| `/aide:ticket-search "JQL"`       | Search Jira tickets       |
| `/aide:ticket-comment KEY "text"` | Add comment to ticket     |
| `/aide:ticket-update KEY`         | Update ticket description |

**PR Commands:**

| Command                           | Description           |
| --------------------------------- | --------------------- |
| `/aide:pr-view --pr ID`           | View PR details       |
| `/aide:pr-diff --pr ID`           | View PR diff          |
| `/aide:pr-comments --pr ID`       | Get PR comments       |
| `/aide:pr-comment "text" --pr ID` | Post comment on PR    |
| `/aide:pr-create --title "..." `  | Create a pull request |
| `/aide:pr-update --pr ID`         | Update a pull request |
| `/aide:pr-reply THREAD "text"`    | Reply to PR thread    |

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
