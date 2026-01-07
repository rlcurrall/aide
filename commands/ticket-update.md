---
description: Update a Jira ticket description
allowed-tools: Bash(aide:*),Read
---

Update a Jira ticket's description.

First, fetch current ticket to see existing description:

```bash
aide jira ticket $ARGUMENTS
```

Then guide the user through updating. Use:

```bash
aide jira desc TICKET-KEY "new description"
```

IMPORTANT: This replaces the entire description. Preserve existing content unless explicitly asked to remove it.
