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
