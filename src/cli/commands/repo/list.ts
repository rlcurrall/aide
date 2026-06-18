/**
 * repo list command - discover git repositories and their worktrees
 *
 * Scans roots for git worktrees by reading git metadata directly (no `git`
 * subprocess), so it is fast enough to run from a SessionStart hook. Roots
 * come from positional args, else $CODE_ROOT, else the current directory.
 */

import { homedir } from 'node:os';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import { handleCommandError } from '@lib/errors.js';
import { validateArgs } from '@lib/validation.js';
import { discoverWorktrees, type Worktree } from '@lib/worktrees.js';
import {
  ListArgsSchema,
  type ListArgs,
  type OutputFormat,
} from '@schemas/repo/list.js';

/** Resolve which roots to scan: args, then $CODE_ROOT, then cwd. */
function resolveRoots(paths: string[]): string[] {
  if (paths.length > 0) return paths;
  if (process.env.CODE_ROOT) return [process.env.CODE_ROOT];
  return [process.cwd()];
}

/** Collapse the home directory prefix to ~ for display. */
function collapseHome(p: string): string {
  const home = homedir().replace(/\\/g, '/');
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function formatBranch(wt: Worktree): string {
  return wt.detached ? `detached@${wt.branch}` : wt.branch;
}

function formatTable(rows: Worktree[], headers: boolean): string {
  if (rows.length === 0) return 'No git worktrees found.';

  const disp = rows.map((wt) => ({
    path: collapseHome(wt.path),
    repo: wt.repo,
    branch: formatBranch(wt),
    primary: wt.primary,
  }));

  let wPath = 4;
  let wRepo = 4;
  for (const d of disp) {
    if (d.path.length > wPath) wPath = d.path.length;
    if (d.repo.length > wRepo) wRepo = d.repo.length;
  }

  const out: string[] = [];
  if (headers) {
    out.push(`${rows.length} worktrees  (* = primary checkout)`);
    out.push(`  ${'PATH'.padEnd(wPath)}  ${'REPO'.padEnd(wRepo)}  BRANCH`);
  }
  for (const d of disp) {
    const mark = d.primary ? '* ' : '  ';
    out.push(
      `${mark}${d.path.padEnd(wPath)}  ${d.repo.padEnd(wRepo)}  ${d.branch}`
    );
  }
  return out.join('\n');
}

function formatMarkdown(rows: Worktree[]): string {
  if (rows.length === 0) return '# Worktrees\n\nNo git worktrees found.';
  const out = [
    '# Worktrees',
    '',
    `Total: ${rows.length}`,
    '',
    '| Path | Repo | Branch | Primary |',
    '| --- | --- | --- | --- |',
  ];
  for (const wt of rows) {
    out.push(
      `| ${collapseHome(wt.path)} | ${wt.repo} | ${formatBranch(wt)} | ${wt.primary ? 'yes' : ''} |`
    );
  }
  return out.join('\n');
}

function render(
  rows: Worktree[],
  format: OutputFormat,
  headers: boolean
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'markdown':
      return formatMarkdown(rows);
    default:
      return formatTable(rows, headers);
  }
}

const HOOK_SNIPPET = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "aide repo list" }
        ]
      }
    ]
  }
}`;

function printHook(): void {
  console.error(
    'Add this to your Claude Code settings.json (e.g. ~/.claude/settings.json).'
  );
  console.error(
    'Pass roots after the command if your code lives elsewhere, e.g. "aide repo list /path/to/code",'
  );
  console.error('or set the CODE_ROOT environment variable.');
  console.error('');
  console.log(HOOK_SNIPPET);
}

async function handler(argv: ArgumentsCamelCase<ListArgs>): Promise<void> {
  const args = validateArgs(ListArgsSchema, argv, 'repo list arguments');

  if (args.printHook) {
    printHook();
    return;
  }

  try {
    const roots = resolveRoots(args.paths);
    const worktrees = discoverWorktrees(roots, args.sort);
    console.log(render(worktrees, args.format, args.headers));
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'list [paths..]',
  describe: 'List git repositories and their worktrees under one or more roots',
  builder: {
    paths: {
      type: 'string',
      array: true,
      describe: 'Roots to scan (default: $CODE_ROOT, else current directory)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
    sort: {
      type: 'string',
      choices: ['path', 'repo'] as const,
      default: 'path' as const,
      describe: 'Sort by path, or cluster by repo',
    },
    headers: {
      type: 'boolean',
      default: true,
      describe: 'Show the count and column headers (use --no-headers to omit)',
    },
    'print-hook': {
      type: 'boolean',
      default: false,
      describe: 'Print a paste-ready SessionStart hook snippet and exit',
    },
  },
  handler,
} satisfies CommandModule<object, ListArgs>;
