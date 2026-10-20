import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { Artifact, ArtifactsReport, DocViewerCard } from "../shared/report";
import { MAX_ARTIFACTS } from "../shared/report";
import { isolatedStatus, repoInfo } from "./git";

const log = (message: string) => console.log(`[turn-report] ${new Date().toISOString()} ${message}`);

const KIND_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  pdf: ["pdf"],
  docx: ["docx"],
  xlsx: ["xlsx"],
  csv: ["csv", "tsv"],
  jsonl: ["jsonl", "ndjson"],
  parquet: ["parquet"],
  pptx: ["pptx"],
  video: ["mp4", "m4v", "mov", "webm"],
  audio: ["mp3", "m4a", "wav", "flac"],
  image: ["png", "jpg", "jpeg", "gif", "tif", "tiff", "heic", "heif", "webp", "svg"],
  ipynb: ["ipynb"],
};

export const ARTIFACT_KINDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KIND_EXTENSIONS).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind])),
);

// What the doc viewer's turn card lists (paseo-doc-viewer shared/kinds.ts and server/recent.ts, scanWorkspace).
export const DOC_VIEWER_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(ARTIFACT_KINDS).filter((extension) => extension !== "svg" && extension !== "ipynb"));
const DOC_VIEWER_SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "target", "vendor"]);
const DOC_VIEWER_SKIP_PREFIXES = ["~$", "._"];
const DOC_VIEWER_MAX_DEPTH = 16;

/** Whether the doc viewer's scan reaches `path`, given relative to its workspace root with "/". */
export function docViewerLists(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop()!;
  const dot = name.lastIndexOf(".");
  return (
    parts.length <= DOC_VIEWER_MAX_DEPTH &&
    // "" is an absolute path's root, and ".." (a dot folder too) leaves the workspace.
    parts.every((dir) => dir !== "" && !dir.startsWith(".") && !DOC_VIEWER_SKIP_DIRS.has(dir)) &&
    !DOC_VIEWER_SKIP_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
    dot > 0 &&
    DOC_VIEWER_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
  );
}

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

/** Pure: which scanned files count as this turn's artifacts, newest first, capped. `covered` ones are only counted. */
export function selectArtifacts(
  files: readonly FileStat[],
  window: TurnWindow,
  covered: (file: FileStat) => boolean = () => false,
  limit = MAX_ARTIFACTS,
): { items: Artifact[]; more: number; covered: number } {
  const from = window.startedAtMs - WINDOW_SLACK_MS;
  const inTurn = files.filter((file) => inWindow(file.mtimeMs, window) && artifactKind(file.path) !== null);
  const matches = inTurn.filter((file) => !covered(file)).sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const items = matches.slice(0, limit).map((file) => ({
    path: file.path,
    kind: artifactKind(file.path) ?? "file",
    size: file.size,
    // birthtime is 0 or unreliable on some filesystems; then everything reads as "changed".
    status: file.birthtimeMs > 0 && file.birthtimeMs >= from ? ("new" as const) : ("changed" as const),
  }));
  return { items, more: Math.max(0, matches.length - limit), covered: inTurn.length - matches.length };
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

/**
 * With a doc viewer card for the turn, documents its scan reaches are left to it. Only files written after this plugin saw
 * the turn start: the viewer judges from its own start, with less slack.
 */
export async function collectArtifacts(root: string, window: TurnWindow | null, card: DocViewerCard | null = null): Promise<ArtifactsReport> {
  if (!window) return { state: "skipped", items: [], more: 0, note: "turn start not observed (plugin started mid-turn)" };
  const { files, truncated } = await scanFiles(root, window.startedAtMs);
  const real = await realpath(root).catch(() => root);
  const inCard = card ? (file: FileStat) => file.mtimeMs >= window.startedAtMs && docViewerLists(relative(card.root, join(real, file.path)).split(sep).join("/")) : undefined;
  const { items, more, covered } = selectArtifacts(files, window, inCard);
  return { state: "done", items, more, note: truncated ? `scan stopped after ${MAX_ENTRIES} entries` : null, ...(card ? { docViewer: { ...card, covered } } : {}) };
}
