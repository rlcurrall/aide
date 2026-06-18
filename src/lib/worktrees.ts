/**
 * Worktree discovery
 *
 * Finds git repositories and all their worktrees under one or more root
 * directories, reading git metadata directly off disk (no `git` subprocess):
 *
 *   - A "primary" checkout is a directory whose `.git` is itself a directory.
 *     Its branch comes from `.git/HEAD` and its repo name from the origin
 *     remote in `.git/config`. Linked worktrees are listed under
 *     `.git/worktrees/<id>/gitdir`.
 *   - A directory whose `.git` is a FILE is a linked worktree; it points back
 *     to its primary via the `gitdir:` line.
 *
 * Each root is scanned as "itself + two levels down", so a code root, a
 * container directory, or a single checkout all resolve. Grouping relies on
 * git's own metadata, so on-disk layout (nested, sibling, or container
 * worktrees) does not matter.
 *
 * This avoids `git` entirely because spawning git per worktree is slow; direct
 * fs reads are dramatically faster, especially on Windows where each process
 * launch is expensive.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';

export interface Worktree {
  /** Absolute path in native form with forward slashes (e.g. "C:/Users/...") */
  path: string;
  /** Origin remote repo name, or the directory name if no origin is set */
  repo: string;
  /** Branch name, or short SHA when in detached HEAD */
  branch: string;
  /** True for the primary checkout of a repo */
  primary: boolean;
  /** True when HEAD is detached (branch holds a short SHA) */
  detached: boolean;
}

/**
 * Normalize a path to native form with forward slashes ("C:/Users/...").
 * Accepts MSYS "/c/...", Windows "C:\\..." or "C:/...", or POSIX "/home/...".
 */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\r/g, '');
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(s);
  if (msys?.[1]) s = `${msys[1].toUpperCase()}:/${msys[2] ?? ''}`;
  const drive = /^([a-z]):\//.exec(s);
  if (drive?.[1]) s = drive[1].toUpperCase() + s.slice(1);
  return s.replace(/\/$/, '');
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readFirstLine(file: string): string | null {
  const buf = readFile(file);
  if (buf == null) return null;
  const nl = buf.indexOf('\n');
  return (nl === -1 ? buf : buf.slice(0, nl)).replace(/\r$/, '');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a HEAD file to [branch, detached]. */
function resolveHead(headFile: string): [string, boolean] {
  const line = readFirstLine(headFile);
  if (line == null) return ['?', false];
  if (line.startsWith('ref:')) {
    return [
      line
        .slice(4)
        .trim()
        .replace(/^refs\/heads\//, ''),
      false,
    ];
  }
  return [line.slice(0, 7), true];
}

/** Origin remote repo name from a gitdir's config, or "" if none. */
function repoName(gitDir: string): string {
  const cfg = readFile(`${gitDir}/config`);
  if (cfg == null) return '';
  let inOrigin = false;
  let url = '';
  for (const raw of cfg.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '[remote "origin"]') {
      inOrigin = true;
      continue;
    }
    if (/^\[.*\]$/.test(line)) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const m = /url\s*=\s*(.*)/.exec(line);
      if (m?.[1] !== undefined) {
        url = m[1].trim();
        break;
      }
    }
  }
  if (!url) return '';
  url = url.replace(/\.git$/, '');
  url = url.slice(url.lastIndexOf('/') + 1);
  url = url.slice(url.lastIndexOf(':') + 1);
  return url;
}

class Scanner {
  private records: Worktree[] = [];
  private seenMain = new Set<string>();
  private claimed = new Set<string>();
  private linked: string[] = [];

  /** If `dir` is a primary checkout, record it and its linked worktrees. */
  private gatherMain(dir: string): void {
    const gitPath = `${dir}/.git`;
    if (!isDir(gitPath)) {
      if (isFile(gitPath)) this.linked.push(dir);
      return;
    }
    if (this.seenMain.has(dir)) return;
    this.seenMain.add(dir);
    this.claimed.add(dir);

    const name = repoName(gitPath) || dir.slice(dir.lastIndexOf('/') + 1);
    const [branch, detached] = resolveHead(`${gitPath}/HEAD`);
    this.records.push({
      path: dir,
      repo: name,
      branch,
      primary: true,
      detached,
    });

    for (const ent of safeReaddir(`${gitPath}/worktrees`)) {
      if (!ent.isDirectory()) continue;
      const wtDir = `${gitPath}/worktrees/${ent.name}`;
      const ptr = readFirstLine(`${wtDir}/gitdir`);
      if (ptr == null) continue;
      const workdir = normalizePath(ptr).replace(/\/\.git$/, '');
      this.claimed.add(workdir);
      const [b, d] = resolveHead(`${wtDir}/HEAD`);
      this.records.push({
        path: workdir,
        repo: name,
        branch: b,
        primary: false,
        detached: d,
      });
    }
  }

  /** Scan a root: itself + worktree-resolve + depth 1 + depth 2. */
  private scanPath(raw: string): void {
    const p = normalizePath(raw);
    this.gatherMain(p);

    // If the root is itself a linked worktree, resolve its primary.
    if (isFile(`${p}/.git`)) {
      const line = readFirstLine(`${p}/.git`);
      if (line) {
        const ptr = line.replace(/^gitdir:\s*/, '');
        this.gatherMain(
          normalizePath(ptr).replace(/\/\.git\/worktrees\/.*$/, '')
        );
      }
    }

    for (const d1 of safeReaddir(p)) {
      if (!d1.isDirectory()) continue;
      const d1p = `${p}/${d1.name}`;
      this.gatherMain(d1p);
      for (const d2 of safeReaddir(d1p)) {
        if (!d2.isDirectory()) continue;
        this.gatherMain(`${d1p}/${d2.name}`);
      }
    }
  }

  scan(roots: string[]): Worktree[] {
    for (const r of roots) this.scanPath(r);

    // Orphans: visible linked worktrees whose primary wasn't gathered.
    for (const cand of this.linked) {
      if (this.claimed.has(cand)) continue;
      const line = readFirstLine(`${cand}/.git`);
      if (!line) continue;
      const ptr = normalizePath(line.replace(/^gitdir:\s*/, ''));
      const [branch, detached] = resolveHead(`${ptr}/HEAD`);
      const name = repoName(ptr.replace(/\/worktrees\/.*$/, '')) || '?';
      this.records.push({
        path: cand,
        repo: name,
        branch,
        primary: false,
        detached,
      });
    }

    return this.records;
  }
}

export type SortMode = 'path' | 'repo';

/**
 * Discover all worktrees under the given roots.
 * @param roots Directories to scan (each as "self + 2 levels down")
 * @param sort  'path' (default) sorts by path; 'repo' clusters by repo then path
 */
export function discoverWorktrees(
  roots: string[],
  sort: SortMode = 'path'
): Worktree[] {
  const records = new Scanner().scan(roots);

  const byPath = (a: Worktree, b: Worktree) => {
    const ap = a.path.toLowerCase();
    const bp = b.path.toLowerCase();
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  };

  if (sort === 'repo') {
    records.sort((a, b) => {
      const ar = a.repo.toLowerCase();
      const br = b.repo.toLowerCase();
      const r = ar < br ? -1 : ar > br ? 1 : 0;
      return r !== 0 ? r : byPath(a, b);
    });
  } else {
    records.sort(byPath);
  }

  return records;
}
