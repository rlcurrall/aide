---
name: pr-view
description: View pull request details including title, status, branches, and description. Use when the user asks about a PR, wants PR context, mentions viewing/checking a pull request, or needs to understand what a PR is about.
allowed-tools: Bash(aide:*)
---

# View Pull Request

View details of a pull request including title, description, status, author, and branches.

## When to Use

- User asks "what's this PR about?" or "show me the PR"
- User wants context before code review
- User mentions a PR number or asks about current branch's PR
- User needs to understand the scope of changes before diving in

## How to Execute

Run:

```bash
aide pr view [--pr <id|url>]
```

- Without `--pr`: auto-detects from current branch
- With `--pr 123`: views specific PR by ID
- With `--pr <url>`: views PR from Azure DevOps or GitHub URL

## Output Includes

1. PR number and title
2. Status (active, completed, abandoned) and draft state
3. Author and creation date
4. Source and target branches
5. Repository and project
6. Description (if present)

## Best Practices

- Always check PR status before starting review
- Note draft state - drafts may have incomplete changes
- Check target branch to understand merge destination
- Look for linked tickets in the description

## Next Steps

After viewing PR details:

- Use **pr-comments** skill to see reviewer feedback
- Use **pr-diff** skill to see code changes
- Use **ticket** skill to load linked Jira context
