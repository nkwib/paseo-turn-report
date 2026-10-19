import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export async function createScratch(repo: RepoInfo): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), "turn-report-"));
  const gitDir = join(dir, "repo");
  try {
    for (const sub of ["objects/info", "refs", "info"]) await mkdir(join(gitDir, sub), { recursive: true });
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/turn-report\n");
    await writeFile(join(gitDir, "config"), await privateConfig(repo));
    await writeFile(join(gitDir, "objects/info/alternates"), `${join(repo.commonDir, "objects")}\n`);
    // Ignore what the repository ignores; a shallow clone's history ends where the repository's does.
    for (const file of ["info/exclude", "shallow"]) await copyFile(join(repo.commonDir, file), join(gitDir, file)).catch(() => {});
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    env: (worktree, indexFile) => ({
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
  await copyFile(realIndex, indexFile).catch(fromHead);
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
