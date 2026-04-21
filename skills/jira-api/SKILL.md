---
name: jira-api
description: Call any Jira REST API endpoint directly via authenticated passthrough. Use when the typed jira subcommands (search, view, create, update, comment, etc.) don't cover the endpoint you need, for custom queries, batch operations, or endpoints like workflows, statuses, components, or versions.
allowed-tools: Bash(aide:*)
---

# Raw Jira REST API Passthrough

Call any Jira REST API endpoint with stored credentials. Mirrors `gh api` ergonomics.

## When to Use

- The typed jira subcommands don't cover the endpoint you need
- Admin endpoints (workflows, statuses, components, versions, permissions)
- Bulk or paginated queries the typed commands don't expose
- Exploring the Jira REST API interactively
- Scripting against Jira REST from an agent

## How to Execute

```bash
aide jira api <endpoint> [options]
```

`<endpoint>` is either a relative path (`rest/api/3/myself`) or an absolute URL on the configured Jira host.

### Options

| Flag         | Short | Description                                                                                    |
| ------------ | ----- | ---------------------------------------------------------------------------------------------- |
| `--method`   | `-X`  | HTTP method: `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`                         |
| `--field`    | `-f`  | String field `key=value`. Querystring on GET/HEAD/DELETE, JSON body otherwise. Repeatable.     |
| `--raw-field`| `-F`  | Typed field `key=value` — coerces `true`/`false`/`null` and JSON numbers. Repeatable.          |
| `--header`   | `-H`  | Extra header `Name: Value`. Repeatable.                                                        |
| `--input`    |       | Raw request body from file path, or `-` for stdin. Incompatible with GET/HEAD/DELETE and `-f`. |

Duplicate `-f`/`-F` keys produce arrays, matching `gh`/`curl` semantics:

```bash
aide jira api rest/api/3/search/jql -f fields=summary -f fields=status
# → ?fields=summary&fields=status
```

## Common Patterns

```bash
# Current user
aide jira api rest/api/3/myself

# JQL search (fields go to querystring on GET)
aide jira api rest/api/3/search/jql -f "jql=project = PROJ" -f maxResults=50

# Create an issue from a JSON file
aide jira api -X POST rest/api/3/issue --input issue.json

# Post a comment via stdin
echo '{"body":"hi"}' | aide jira api -X POST rest/api/3/issue/PROJ-1/comment --input -

# Typed fields (numbers, booleans, null)
aide jira api -X POST rest/api/3/issue -F "fields.priority.id=3" -F "fields.labels=null"

# List statuses (no typed command covers this)
aide jira api rest/api/3/statuses

# Add a custom header
aide jira api rest/api/3/myself -H "X-Atlassian-Token: no-check"
```

## Output

- Raw response body streams directly to stdout (no decoding, no newline mutation — binary payloads pass through intact).
- Non-2xx responses print the server's error envelope and exit with code 1.
- 3xx redirects are not followed (credentials aren't replayed across origins); a warning is written to stderr.

## Security Guards

- Relative paths resolve against your configured Jira host.
- Absolute URLs are accepted only when HTTPS **and** on the configured host. Cross-host or `http://` URLs are rejected before the request is sent.
- Userinfo in the URL (`https://user:pass@...`) is stripped before the request goes out.

## When NOT to Use

Prefer the typed commands when they cover what you need — they handle ADF ↔ Markdown conversion, field name resolution, and custom-field formatting automatically:

| Instead of `aide jira api ...`                                         | Use                     |
| ---------------------------------------------------------------------- | ----------------------- |
| `aide jira api rest/api/3/issue/PROJ-1`                                | `aide jira view PROJ-1` |
| `aide jira api rest/api/3/search/jql -f jql=...`                       | `aide jira search "..."`|
| `aide jira api -X POST rest/api/3/issue/PROJ-1/comment --input ...`    | `aide jira comment PROJ-1 "..."` |
| `aide jira api -X PUT rest/api/3/issue/PROJ-1 --input ...`             | `aide jira update PROJ-1 --field ...` |

The raw `api` command is the escape hatch — reach for it when the typed command falls short.
