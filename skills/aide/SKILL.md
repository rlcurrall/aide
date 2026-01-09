---
name: aide
description: AI agent integration with Jira and Azure DevOps for ticket-driven development and PR review workflows
allowed-tools: Bash(aide:*),Read
version: 0.0.1
author: Robb Currall
license: MIT
---

# aide CLI - AI Agent Integration

The aide CLI provides AI coding agents with tools to interact with Jira and Azure DevOps APIs for ticket-driven development and PR review workflows.

## Quick Reference

### Jira Commands

| Command                        | Description                   |
| ------------------------------ | ----------------------------- |
| `aide jira search "JQL"`       | Search tickets with JQL query |
| `aide jira ticket KEY`         | Get ticket details            |
| `aide jira comment KEY "text"` | Add comment to ticket         |
| `aide jira comments KEY`       | Get ticket comments           |
| `aide jira desc KEY "text"`    | Update ticket description     |

### Pull Request Commands

| Command                            | Description        |
| ---------------------------------- | ------------------ |
| `aide pr list`                     | List pull requests |
| `aide pr create`                  | Create a PR        |
| `aide pr update [--pr ID]`        | Update a PR        |
| `aide pr comments [--pr ID]`      | Get PR comments    |
| `aide pr comment "msg" [--pr ID]` | Post PR comment    |
| `aide pr reply <thread> "msg"`    | Reply to thread    |

## Ticket-Driven Development Workflow

### Starting Work on a Ticket

1. **Load ticket context**: Use `aide jira ticket KEY` to fetch full ticket details
2. **Understand requirements**: Review description, acceptance criteria, and comments
3. **Check for blockers**: Look for linked issues or dependencies mentioned
4. **Review recent comments**: Use `aide jira comments KEY --latest 5` to see recent discussion

### During Development

1. **Reference the ticket**: Keep ticket requirements in mind while coding
2. **Track progress**: Add comments to the ticket as you complete milestones
3. **Update description**: If scope changes, update the ticket description
4. **Stay aligned**: Check for new comments periodically

### Completing Work

1. **Add summary comment**: Document what was implemented
2. **Reference in commits**: Include ticket key in commit messages (e.g., "PROJ-123: Add feature")
3. **Update status**: Note completion in ticket comments
4. **Link PR**: Mention the PR number in a closing comment

## PR Review Workflow

### Loading PR Feedback

1. **Fetch comments**: Use `aide pr comments --pr PR-ID` to load all PR comments
2. **Filter active threads**: Use `--thread-status active` to focus on unresolved feedback
3. **Get latest**: Use `--latest N` to see most recent comments
4. **Filter by reviewer**: Use `--author "email"` to see specific reviewer feedback

### Addressing Feedback

1. **Prioritize**: Address blocking/critical feedback first
2. **Understand context**: Read the full thread, not just the latest comment
3. **Implement fixes**: Make changes based on feedback
4. **Respond**: If needed, add comments explaining your changes

### Common Patterns

```bash
# Get active PR feedback
aide pr comments --pr 24094 --thread-status active

# Get latest 10 comments
aide pr comments --pr 24094 --latest 10

# Get comments from specific reviewer
aide pr comments --pr 24094 --author "reviewer@company.com"

# Use full PR URL (auto-extracts org/project/repo)
aide pr comments --pr https://dev.azure.com/org/project/_git/repo/pullrequest/24094

# JSON format for structured processing
aide pr comments --pr 24094 --format json

# Auto-detect PR from current branch
aide pr comments --latest 10
```

## PR Management Workflow

### Creating a Pull Request

1. **Prepare your branch**: Ensure all changes are committed and pushed
2. **Create the PR**: Use `aide pr create --title "Title" --target main`
3. **Add description**: Include context with `--description` flag or update later
4. **Draft mode**: Use `--draft` flag for work-in-progress PRs

### Managing PR Lifecycle

```bash
# Create a draft PR
aide pr create --title "WIP: Add authentication" --target develop --draft

# Update PR title or description
aide pr update --pr 24094 --title "Add OAuth authentication"

# Publish draft when ready for review
aide pr update --pr 24094 --publish

# Convert back to draft if more work needed
aide pr update --pr 24094 --draft

# Abandon PR if no longer needed
aide pr update --pr 24094 --abandon

# Reactivate abandoned PR
aide pr update --pr 24094 --activate
```

### Responding to PR Feedback

1. **Load comments**: Use `aide pr comments --pr PR-ID --thread-status active`
2. **Address code changes**: Implement requested changes
3. **Reply to threads**: Use `aide pr reply THREAD-ID "message" --pr PR-ID`
4. **Post updates**: Use `aide pr comment "Ready for re-review" --pr PR-ID`

### Commenting on PRs

```bash
# Add general PR comment (auto-detect PR from branch)
aide pr comment "Ready for re-review"

# Comment on specific PR
aide pr comment "Ready for re-review" --pr 24094

# Comment on specific file
aide pr comment "Consider refactoring this" --pr 24094 --file src/auth.ts

# Comment on specific line
aide pr comment "Add error handling here" --pr 24094 --file src/auth.ts --line 42

# Reply to existing thread
aide pr reply 156 "Fixed in latest commit" --pr 24094
```

## Best Practices

### For Ticket Work

- Always load ticket context before starting implementation
- Keep the ticket updated as you progress
- Use ticket key in commit messages for traceability
- Check comments for clarifications from stakeholders
- When updating descriptions, preserve important existing content

### For PR Reviews

- Address all active threads before marking PR ready
- Use JSON format (`--format json`) when you need structured data
- Group related feedback when implementing fixes
- Check for system comments that may indicate build/test status

### Output Formats

All commands support `--format` flag:

| Format           | Use Case                                    |
| ---------------- | ------------------------------------------- |
| `text` (default) | Human-readable output for review            |
| `json`           | Structured data for programmatic processing |
| `markdown`       | Documentation-friendly format               |

## Common JQL Patterns

### Personal Queries

```bash
# My open tickets
aide jira search "assignee = currentUser() AND status != Closed"

# My in-progress work
aide jira search "assignee = currentUser() AND status = 'In Progress'"

# Tickets I'm watching
aide jira search "watcher = currentUser()"
```

### Project Queries

```bash
# All open bugs in project
aide jira search "project = PROJ AND issuetype = Bug AND status != Closed"

# High priority unassigned
aide jira search "project = PROJ AND priority = High AND assignee IS EMPTY"

# Sprint tickets
aide jira search "project = PROJ AND sprint in openSprints()"
```

### Time-Based Queries

```bash
# Recent bugs (last 7 days)
aide jira search "issuetype = Bug AND created >= -7d"

# Updated this week
aide jira search "updated >= startOfWeek()"

# Resolved this month
aide jira search "resolved >= startOfMonth()"
```

### Text Search

```bash
# Search by keyword
aide jira search "text ~ 'authentication'"

# Search in summary only
aide jira search "summary ~ 'login bug'"

# Combine with filters
aide jira search "project = PROJ AND text ~ 'performance' AND priority = High"
```

## Auto-Discovery

When running from a git repository with an Azure DevOps remote, the CLI automatically detects:

- **Organization** - From the remote URL
- **Project** - From the remote URL
- **Repository** - From the remote URL

Supported remote formats:

- SSH: `git@ssh.dev.azure.com:v3/org/project/repo`
- HTTPS: `https://dev.azure.com/org/project/_git/repo`

You can override with explicit flags:

```bash
aide pr list --project MyProject --repo MyRepo
aide pr comments --pr 24094 --project MyProject --repo MyRepo
```

## Error Handling

### Common Issues

| Error                 | Cause                          | Solution                                 |
| --------------------- | ------------------------------ | ---------------------------------------- |
| Authentication failed | Invalid or expired credentials | Check JIRA_API_TOKEN or AZURE_DEVOPS_PAT |
| Resource not found    | Invalid ticket/PR ID           | Verify the ID is correct                 |
| Permission denied     | Insufficient access            | Ensure you have access to the resource   |
| Network error         | Connectivity issues            | Check network and service URLs           |

### Troubleshooting Steps

1. **Check environment variables**:
   - Jira: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
   - Azure DevOps: `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PAT`

2. **Verify credentials**:
   - API tokens may expire
   - PATs require appropriate scopes (Code Read for PRs)

3. **Test connectivity**:
   - Try a simple command like `aide jira search "project = PROJ" 1`
   - Use `--help` flag for command-specific guidance

4. **Check permissions**:
   - Ensure you have access to the project/repository
   - Some resources may be restricted to certain users

## Integration Examples

### Load Ticket and Start Work

```bash
# Get full ticket context
aide jira ticket PROJ-123

# Check recent discussion
aide jira comments PROJ-123 --latest 5

# After understanding requirements, begin implementation
```

### Update Ticket During Work

```bash
# Add progress update
aide jira comment PROJ-123 "Started implementation of the authentication module. ETA: 2 hours."

# Add technical notes
aide jira comment PROJ-123 "Technical note: Using OAuth 2.0 with PKCE flow for enhanced security."
```

### Review and Address PR Feedback

```bash
# Get all active feedback
aide pr comments --pr 24094 --thread-status active

# Get specific reviewer's comments
aide pr comments --pr 24094 --author "senior.dev@company.com"

# After addressing feedback, verify no remaining active threads
aide pr comments --pr 24094 --thread-status active
```

### Cross-Reference Ticket and PR

```bash
# Get ticket for context
aide jira ticket PROJ-123

# Get PR comments for feedback
aide pr comments --pr 24094 --format json

# Add closing comment to ticket
aide jira comment PROJ-123 "Implementation complete. PR #24094 merged. Changes include:
- Added OAuth 2.0 authentication
- Implemented token refresh logic
- Added unit tests for auth module"
```
