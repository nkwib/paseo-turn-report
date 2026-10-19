import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { Artifact, ArtifactsReport } from "../shared/report";
import { MAX_ARTIFACTS } from "../shared/report";
import { isolatedStatus, repoInfo } from "./git";

const log = (message: string) => console.log(`[turn-report] ${new Date().toISOString()} ${message}`);

export const ARTIFACT_KINDS: Readonly<Record<string, string>> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  csv: "csv",
  pptx: "pptx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  jsonl: "jsonl",
  ipynb: "ipynb",
};

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache", "target", ".gradle", ".idea"]);
const MAX_ENTRIES = 20_000;
const MAX_STATUS_ENTRIES = 2_000;
const MAX_DEPTH = 10;
/** Filesystem mtime granularity and clock skew between the agent's process and ours. */
const WINDOW_SLACK_MS = 1_500;

export interface FileStat {
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
}

export interface TurnWindow {
  startedAtMs: number;
  endedAtMs: number;
}

const inWindow = (mtimeMs: number, window: TurnWindow) => mtimeMs >= window.startedAtMs - WINDOW_SLACK_MS && mtimeMs <= window.endedAtMs + WINDOW_SLACK_MS;

/** Pure: which scanned files count as this turn's artifacts, newest first, capped. */
export function selectArtifacts(files: readonly FileStat[], window: TurnWindow, limit = MAX_ARTIFACTS): { items: Artifact[]; more: number } {
  const from = window.startedAtMs - WINDOW_SLACK_MS;
  const matches = files
    .filter((file) => inWindow(file.mtimeMs, window) && artifactKind(file.path) !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const items = matches.slice(0, limit).map((file) => ({
    path: file.path,
    kind: artifactKind(file.path) ?? "file",
    size: file.size,
    // birthtime is 0 or unreliable on some filesystems; then everything reads as "changed".
    status: file.birthtimeMs > 0 && file.birthtimeMs >= from ? ("new" as const) : ("changed" as const),
  }));
  return { items, more: Math.max(0, matches.length - limit) };
}

export function artifactKind(path: string): string | null {
  return ARTIFACT_KINDS[extname(path).slice(1).toLowerCase()] ?? null;
}

/** Bounded walk of `root`: skips VCS and dependency folders and symlinks; paths are relative with "/". */
export async function scanFiles(root: string, sinceMs: number): Promise<{ files: FileStat[]; truncated: boolean }> {
  const files: FileStat[] = [];
  let seen = 0;
  let truncated = false;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) {
        truncated = true;
        return { files, truncated };
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || artifactKind(entry.name) === null) continue;
      try {
        const stat = await lstat(full);
        if (stat.mtimeMs < sinceMs - WINDOW_SLACK_MS) continue;
        files.push({ path: relative(root, full).split(sep).join("/"), mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return { files, truncated };
}

/**
 * The files git reports changed in the worktree, kept to those modified inside the turn window. Read through an isolated
 * git directory (git.ts, isolatedStatus) so no clean or process filter, fsmonitor hook or merge driver the repository's,
 * global or system config names runs during this passive scan. The real index and objects are never written.
 *
 * Tracked changes come from `git diff HEAD` (content comparison, so a change that the repository's line-ending settings
 * normalize away, such as a CRLF-only touch, is not reported); untracked files from `git ls-files --others`, which
 * respects .gitignore, info/exclude and core.excludesFile. Plain `git status` would report a stat-dirty line-ending-only
 * change as modified; the diff does not. `--ignore-submodules=dirty` keeps the daemon from entering a submodule's own
 * working tree, where a clean or process filter the submodule's config names would run (the isolated git dir only
 * neutralizes the parent's config); a changed submodule commit is a gitlink directory and is dropped below with the
 * other non-file entries. The separate document walk reads only filesystem metadata.
 */
export async function changedFiles(root: string, window: TurnWindow): Promise<string[]> {
  const repo = await repoInfo(root);
  if (!repo) return [];
  const read = async (label: string, args: string[]): Promise<string[]> => {
    const result = await isolatedStatus(repo, root, args).catch((error) => {
      log(`artifact git ${label} errored: ${String(error).slice(0, 200)}`);
      return null;
    });
    if (!result) return [];
    if (result.code !== 0) {
      log(`artifact git ${label} failed (${result.code}): ${result.stderr.trim().slice(0, 200)}`);
      return [];
    }
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
  };
  const [tracked, untracked] = await Promise.all([
    read("diff", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", "--ignore-submodules=dirty", "HEAD"]),
    read("ls-files", ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  const paths = [...new Set([...tracked, ...untracked])].slice(0, MAX_STATUS_ENTRIES);
  const kept = await Promise.all(
    paths.map(async (path) => {
      const stat = await lstat(join(root, path)).catch(() => null);
      return stat?.isFile() && inWindow(stat.mtimeMs, window) ? path : null;
    }),
  );
  return kept.filter((path): path is string => path !== null);
}

export async function collectArtifacts(root: string, window: TurnWindow | null): Promise<ArtifactsReport> {
  if (!window) return { state: "skipped", items: [], more: 0, note: "turn start not observed (plugin started mid-turn)" };
  const { files, truncated } = await scanFiles(root, window.startedAtMs);
  const { items, more } = selectArtifacts(files, window);
  return { state: "done", items, more, note: truncated ? `scan stopped after ${MAX_ENTRIES} entries` : null };
}
