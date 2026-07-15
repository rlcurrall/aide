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

Command ownership is hybrid. Built-in plugin descriptors live under
`src/cli/plugins/*`; plugin-owned PR and Prime implementations are co-located
there under pull-requests and aide-core. Internal command/plugin descriptors,
`CommandRegistry`, and runtime composition live in `src/cli/host`. yargs remains
the CLI adapter at `src/cli/host/yargs-adapter.ts`. Remaining legacy yargs
`CommandModule`s are still under `src/cli/commands` and are registered through
their owning built-in plugins.

## Running

    bun install
    bun run dev <service> <command> [flags]
    bun test
    bun run lint
    bunx tsc --noEmit

## Credentials

Credential resolution and account discovery are provider- and scope-specific;
do not assume one universal precedence. Scoped stored credentials use the auth
store/keyring. See `src/lib/config.ts` for Jira/ADO probes,
`src/lib/github-credential-resolver.ts` for exact GitHub resolution, and
`src/cli/plugins/builtin-auth-provider-discovery.ts` plus
`src/cli/plugins/github/auth-discovery.ts` for omitted-scope account discovery.

## Output Formats

Most commands accept `--format json|text|markdown`. Agents should prefer
`--format json` for structured parsing.

## Conventions

- Conventional commits: `type(scope): message`
- Descriptor and new command implementations propagate failures or throw rather
  than calling `process.exit`. Existing legacy and plugin-local yargs handlers
  may still render errors and exit through local helpers. yargs `.fail` owns
  parser/usage failures; the top-level catch owns propagated failures and
  cancellation.
- Auto-discovery of org/project/repo from git remote; override with
  explicit flags when needed.
