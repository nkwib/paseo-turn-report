import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { externalEnv } from "./env";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Variables that point git at another repository, index or object store (`git rev-parse --local-env-vars`):
// the daemon's own environment must not redirect these calls.
const LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
];

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  const base = externalEnv();
  for (const key of LOCAL_ENV_VARS) delete base[key];
  return new Promise((done) => {
    execFile(
      "git",
      // A repository's config can name an fsmonitor hook, which any command that reads the index would start
      // (Paseo turns it off the same way, run-git-command.ts). Clean filters and merge drivers: see createScratch.
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        // Never prompt, never run a pager, never take optional locks, never fetch missing objects of a partial clone.
        env: { ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_NO_LAZY_FETCH: "1", ...env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.trim();
}

export interface RepoInfo {
  toplevel: string;
  commonDir: string;
  branch: string;
  head: string;
}

export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
  // --abbrev-ref applies to every revision after it, so HEAD's commit comes first. An absolute common dir is a real path,
  // like the toplevel: the main worktree's raw ".git" resolved against a symlinked cwd would not match its linked worktrees.
  const result = await git(cwd, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD"]);
  if (result.code !== 0) return null;
  const [toplevel, commonDir, head, branch] = result.stdout.trim().split("\n");
  if (!toplevel || !commonDir || !head) return null;
  return { toplevel, commonDir, branch: branch ?? "HEAD", head };
}

/**
 * A private repository for the conflict check: its own config, index and object directory, the repository's objects read
 * through alternates. `add` and `merge-tree` run against it, so the repository's config, info/attributes and hooks are
 * never read: no clean filter or merge driver an agent wrote into .git/config can run. In-tree .gitattributes still
 * apply, but a driver they name is undefined here, so git falls back to its built-in behavior. Every object git writes
 * lands in the scratch object directory; the agent's worktree, its index and the shared object store are never written.
 */
export interface Scratch {
  env(worktree: string, indexFile: string): NodeJS.ProcessEnv;
  indexFile(name: string): string;
  dispose(): Promise<void>;
}

// Set by `git init` from what the filesystem supports; snapshots of the same worktree must read files the same way.
const FILESYSTEM_CONFIG = /^core\.(filemode|symlinks|ignorecase|precomposeunicode) (true|false)$/i;

async function privateConfig(repo: RepoInfo): Promise<string> {
  const format = (await git(repo.toplevel, ["rev-parse", "--show-object-format"])).stdout.trim() || "sha1";
  const core = (await git(repo.toplevel, ["config", "--get-regexp", "^core\\.(filemode|symlinks|ignorecase|precomposeunicode)$"])).stdout
    .split("\n")
    .flatMap((line) => {
      const match = FILESYSTEM_CONFIG.exec(line.trim());
      return match ? [`\t${match[1]!.toLowerCase()} = ${match[2]!.toLowerCase()}`] : [];
    });
  const sha1 = format === "sha1";
  return ["[core]", `\trepositoryformatversion = ${sha1 ? 0 : 1}`, "\tbare = false", ...core, ...(sha1 ? [] : ["[extensions]", `\tobjectformat = ${format}`]), ""].join("\n");
}

/**
 * Builds a private git directory that reads the repository's objects through alternates and its config only for the
 * filesystem settings. `head` is the literal HEAD contents ("ref: ..." for the conflict check, a commit id for a
 * detached status read). No filter, merge driver or fsmonitor hook the repository's config names is reachable here.
 */
async function initScratchGitDir(repo: RepoInfo, gitDir: string, head: string): Promise<void> {
  for (const sub of ["objects/info", "refs", "info"]) await mkdir(join(gitDir, sub), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), head);
  await writeFile(join(gitDir, "config"), await privateConfig(repo));
  await writeFile(join(gitDir, "objects/info/alternates"), `${join(repo.commonDir, "objects")}\n`);
  // Ignore what the repository ignores; a shallow clone's history ends where the repository's does.
  for (const file of ["info/exclude", "shallow"]) await copyFile(join(repo.commonDir, file), join(gitDir, file)).catch(() => {});
}

// Blocks global and system git config so neither can name an executable driver, hook or textconv the daemon would run
// during a passive read. The repository's own filesystem settings are carried in the scratch config (privateConfig);
// other safe, non-executable settings are re-injected by safeConfigEnv. devNull is the empty config on this platform.
const NO_OUTSIDE_CONFIG: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

// Non-executable settings that change how git reads a worktree's bytes or decides what is ignored. Dropping the outside
// config would otherwise change what a passive read reports (CRLF files look modified, custom ignores stop applying) and
// make the conflict check invent content conflicts between CRLF worktrees. Enums are whitelisted; anything that could
// name a command (filters, hooks, drivers, textconv) is never carried over.
const SAFE_ENUM_SETTINGS: Readonly<Record<string, ReadonlySet<string>>> = {
  "core.autocrlf": new Set(["true", "false", "input"]),
  "core.eol": new Set(["lf", "crlf", "native"]),
  "core.safecrlf": new Set(["true", "false", "warn"]),
};

/**
 * Re-applies the repository's effective safe settings through the injection-proof GIT_CONFIG_* variables (values are
 * opaque strings, never parsed as config text). The effective values are read in the real environment, so a setting from
 * repository, global or system config is preserved; only the whitelisted keys are carried, validated against their enums.
 * core.excludesFile is read as an expanded absolute path and passed verbatim (a non-executable ignore file).
 */
async function safeConfigEnv(repo: RepoInfo): Promise<NodeJS.ProcessEnv> {
  const pairs: [string, string][] = [];
  for (const [key, allowed] of Object.entries(SAFE_ENUM_SETTINGS)) {
    const value = (await git(repo.toplevel, ["config", "--get", key])).stdout.trim().toLowerCase();
    if (allowed.has(value)) pairs.push([key, value]);
  }
  const excludes = (await git(repo.toplevel, ["config", "--get", "--type=path", "core.excludesFile"])).stdout.trim();
  if (excludes) pairs.push(["core.excludesFile", excludes]);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Preserve Git's racy-index check: a fresh copy timestamp could make an unchanged stat cache hide newer content. */
async function copyIndex(source: string, target: string): Promise<void> {
  const original = await stat(source);
  await copyFile(source, target);
  // Round down, so timestamp precision loss can only cause extra hashing, never hide a racy entry.
  await utimes(target, original.atime, new Date(Math.floor(original.mtimeMs)));
}

export async function createScratch(repo: RepoInfo): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), "turn-report-"));
  const gitDir = join(dir, "repo");
  let configEnv: NodeJS.ProcessEnv;
  try {
    await initScratchGitDir(repo, gitDir, "ref: refs/heads/turn-report\n");
    configEnv = await safeConfigEnv(repo);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    env: (worktree, indexFile) => ({
      ...NO_OUTSIDE_CONFIG,
      ...configEnv,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: worktree,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: "turn-report",
      GIT_AUTHOR_EMAIL: "turn-report@localhost",
      GIT_COMMITTER_NAME: "turn-report",
      GIT_COMMITTER_EMAIL: "turn-report@localhost",
    }),
    indexFile: (name) => join(dir, `${name}.index`),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Commit the worktree's current state (tracked changes and untracked, non-ignored files) on top of its HEAD. */
export async function snapshotWorktree(scratch: Scratch, worktree: RepoInfo, name: string): Promise<string> {
  const cwd = worktree.toplevel;
  const indexFile = scratch.indexFile(name);
  const env = scratch.env(cwd, indexFile);
  const fromHead = async () => {
    await rm(indexFile, { force: true });
    await gitOk(cwd, ["read-tree", worktree.head], env);
  };
  // Starting from a copy of the real index lets git reuse its stat cache (about 10x faster on big repos).
  const realIndex = await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  await copyIndex(realIndex, indexFile).catch(fromHead);
  // A copy can name files only the repository has (a split index): start from HEAD instead.
  if ((await git(cwd, ["add", "-A", "--", "."], env)).code !== 0) {
    await fromHead();
    await gitOk(cwd, ["add", "-A", "--", "."], env);
  }
  const tree = await gitOk(cwd, ["write-tree"], env);
  return gitOk(cwd, ["commit-tree", tree, "-p", worktree.head, "-m", "turn-report snapshot"], env);
}

export async function mergeTree(scratch: Scratch, cwd: string, a: string, b: string): Promise<GitResult> {
  return git(cwd, ["merge-tree", "--write-tree", "--name-only", "-z", a, b], scratch.env(cwd, scratch.indexFile("merge")));
}

/**
 * Runs a read-only `git status` (or similar worktree read) for the passive artifact scan, isolated the same way the
 * conflict check is: a private GIT_DIR whose config holds only the repository's filesystem settings, HEAD detached at
 * the real commit, the repository's objects through alternates, and a copy of info/exclude. Global and system config
 * are dropped too. So no clean or process filter, fsmonitor hook or merge driver that any config names can run, as one
 * would on `git status` in the real repository. In-tree .gitignore and .gitattributes still apply, but a driver an
 * attribute names is undefined here, so git falls back to its built-in behavior. The real index and object store are
 * never written: status reads a disposable copy of the index, or a fresh one built from HEAD when the copy is unusable
 * (a split index names files only the real repository has). `cwd` sets what the output paths are relative to.
 */
export async function isolatedStatus(repo: RepoInfo, cwd: string, args: string[]): Promise<GitResult> {
  const dir = await mkdtemp(join(tmpdir(), "turn-report-status-"));
  const gitDir = join(dir, "repo");
  const indexFile = join(dir, "status.index");
  try {
    await initScratchGitDir(repo, gitDir, `${repo.head}\n`);
    const env: NodeJS.ProcessEnv = { ...NO_OUTSIDE_CONFIG, ...(await safeConfigEnv(repo)), GIT_DIR: gitDir, GIT_WORK_TREE: repo.toplevel, GIT_INDEX_FILE: indexFile };
    const fromHead = async () => {
      await rm(indexFile, { force: true });
      await gitOk(cwd, ["read-tree", repo.head], env);
    };
    // Starting from a copy of the real index lets git reuse its stat cache; absent or unusable, build one from HEAD.
    const realIndex = await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    await copyIndex(realIndex, indexFile).catch(fromHead);
    let result = await git(cwd, args, env);
    if (result.code !== 0) {
      await fromHead();
      result = await git(cwd, args, env);
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
