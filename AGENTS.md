# AGENTS.md

Repository guide for AI coding agents. For Claude Code specifically, see
CLAUDE.md - it contains the same information with Claude-specific notes.

## Project

aide CLI - unified wrapper around Jira, Azure DevOps, and GitHub APIs.
Built with Bun + TypeScript. Entry point: `src/cli/index.ts`.

## Command Surface

Services: `jira`, `pr`, `plugin`. Top-level: `login`, `logout`, `whoami`,
`prime`, `upgrade`.

- Jira: search, view, create, update, transition, comment, comments,
  delete-comment, edit-comment, attach, fields, boards, sprint
- PR: list, view, diff, create, update, comments, comment, reply
- Plugin: install, status, uninstall

Each command is a yargs CommandModule under `src/cli/commands/<service>/`.

## Running

    bun install
    bun run dev <service> <command> [flags]
    bun test
    bun run lint
    bunx tsc --noEmit

## Credentials

OS keyring first (set via `aide login <service>`), environment variables
as fallback. See `src/lib/config.ts` for the probe functions.

## Output Formats

Most commands accept `--format json|text|markdown`. Agents should prefer
`--format json` for structured parsing.

## Conventions

- Conventional commits: `type(scope): message`
- Errors are thrown, not `process.exit`. Top-level handler at
  `src/cli/index.ts` translates to exit codes.
- Auto-discovery of org/project/repo from git remote; override with
  explicit flags when needed.

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
