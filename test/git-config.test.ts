import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { changedFiles } from "../server/artifacts";
import { detectCollisions } from "../server/collisions";
import { repoInfo } from "../server/git";

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd: string, ...args: string[]) => sh(cwd, ENV, ...args);
const window = () => {
  const now = Date.now();
  return { startedAtMs: now - 60_000, endedAtMs: now + 60_000 };
};
/** Writes a marker under `<root>/markers/<name>` when git runs it, then does `body`. Returns the script path. */
async function marker(root: string, name: string, body: string): Promise<string> {
  const path = join(root, `${name}.sh`);
  await writeFile(path, `#!/bin/sh\ntouch '${join(root, "markers", name)}'\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function newRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(async () => {
    await chmod(join(root, "repo"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "markers"));
  return root;
}

/**
 * Changes `file` to new content of the same byte length as what is committed. git cannot tell from size whether it
 * changed, so a plain `git status` rehashes it and runs any clean or process filter its attributes name. This is the
 * real `git status` exposure the hardening closes. The mtime is set a few seconds back (still inside the turn window)
 * so it reliably differs from the just-written index entry: equal size and mtime would let git skip the hash (the
 * racy-git case), which would make the test flaky without changing what the hardening proves.
 */
async function sameSizeEdit(repo: string, file: string, content: string) {
  const path = join(repo, file);
  await writeFile(path, content);
  const back = new Date(Date.now() - 10_000);
  await utimes(path, back, back);
}

/**
 * Two worktrees of a repository whose .git/config, which an agent can write, names commands: an fsmonitor hook, a clean
 * filter and a merge driver. Each writes a marker file when git runs it. Both worktrees change f.txt and write an ignored file.
 */
async function hostileRepo() {
  const root = await newRoot("tr-hostile-");
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "f.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil merge=evil\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const a = join(root, "a");
  const b = join(root, "b");
  git(repo, "worktree", "add", "-q", "-b", "a", a);
  git(repo, "worktree", "add", "-q", "-b", "b", b);
  await writeFile(join(a, "f.txt"), "one\nfrom a\nthree\n");
  await writeFile(join(b, "f.txt"), "one\nfrom b\nthree\n");
  await writeFile(join(a, "new.txt"), "untracked\n");
  // The private repository ignores what the repository ignores.
  await writeFile(join(repo, ".git/info/exclude"), "secret.log\n");
  await writeFile(join(a, "secret.log"), "a\n");
  await writeFile(join(b, "secret.log"), "b\n");

  const config = [
    ["core.fsmonitor", await marker(root, "fsmonitor", "exit 1")],
    ["filter.evil.clean", await marker(root, "clean", "cat")],
    ["merge.evil.driver", `${await marker(root, "merge", "exit 1")} %O %A %B`],
  ];
  // Set last: from here on, only the code under test runs git in this repository.
  for (const [key, value] of config) git(repo, "config", key!, value!);
  return { root, repo, a, b, ran: () => readdir(join(root, "markers")) };
}

describe("repository git config", () => {
  it("the conflict check runs no command the repository's config names", async () => {
    const { a, b, ran } = await hostileRepo();
    const report = await detectCollisions(a, [{ agentId: "B", title: "B", cwd: b }]);
    expect(report.items.map((peer) => peer.files)).toEqual([[{ path: "f.txt", kind: "content" }]]);
    expect(await ran()).toEqual([]);

    // Control: git itself runs each of them in this repository.
    git(a, "status", "--porcelain");
    git(a, "commit", "-qam", "a");
    git(b, "commit", "-qam", "b");
    try {
      git(a, "merge-tree", "--write-tree", "a", "b");
    } catch {
      // exit 1: conflicts
    }
    expect((await ran()).sort()).toEqual(["clean", "fsmonitor", "merge"]);
  });

  it("the passive artifact status starts no clean filter or fsmonitor hook on a racily clean file", async () => {
    const root = await newRoot("tr-clean-");
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "f.txt"), "aaaaa\n");
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "config", "filter.evil.clean", await marker(root, "clean", "cat"));
    git(repo, "config", "core.fsmonitor", await marker(root, "fsmonitor", "exit 1"));
    await writeFile(join(repo, ".git/info/exclude"), "secret.log\n");
    await writeFile(join(repo, "secret.log"), "ignored\n");
    await writeFile(join(repo, "new.pdf"), "x\n");
    await sameSizeEdit(repo, "f.txt", "bbbbb\n");
    expect(await repoInfo(repo)).toMatchObject({ branch: "main" });

    // The racily clean tracked file and the untracked file are reported; the ignored file is not.
    expect((await changedFiles(repo, window())).sort()).toEqual(["f.txt", "new.pdf"]);
    expect(await readdir(join(root, "markers"))).toEqual([]);

    // Control: the same racy state makes plain git status rehash f.txt and run the clean filter.
    await sameSizeEdit(repo, "f.txt", "ccccc\n");
    git(repo, "status", "--porcelain");
    expect((await readdir(join(root, "markers"))).includes("clean")).toBe(true);
  });

  it("the passive artifact status starts no process filter on a racily clean file", async () => {
    const root = await newRoot("tr-proc-");
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "g.dat"), "alpha\n");
    await writeFile(join(repo, ".gitattributes"), "*.dat filter=proc\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "config", "filter.proc.process", await marker(root, "process", "exit 1"));
    await sameSizeEdit(repo, "g.dat", "omega\n");

    expect((await changedFiles(repo, window())).sort()).toEqual(["g.dat"]);
    expect(await readdir(join(root, "markers"))).toEqual([]);

    // Control: the same racy state makes plain git status spawn the process filter.
    await sameSizeEdit(repo, "g.dat", "gamma\n");
    try {
      git(repo, "status", "--porcelain");
    } catch {
      // the broken process filter exits 1
    }
    expect((await readdir(join(root, "markers"))).includes("process")).toBe(true);
  });

  it("the passive artifact status ignores a driver named only in global config", async () => {
    const root = await newRoot("tr-global-");
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "f.txt"), "aaaaa\n");
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=ghost\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    await sameSizeEdit(repo, "f.txt", "bbbbb\n");
    // The driver lives only in a global config file, never in the repository.
    const globalConfig = join(root, "global.gitconfig");
    await writeFile(globalConfig, `[filter "ghost"]\n\tclean = ${await marker(root, "clean", "cat")}\n`);

    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      expect((await changedFiles(repo, window())).sort()).toEqual(["f.txt"]);
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
    }
    expect(await readdir(join(root, "markers"))).toEqual([]);

    // Control: git with that global config does run the clean filter on the same racy status.
    await sameSizeEdit(repo, "f.txt", "ccccc\n");
    sh(repo, { ...ENV, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" }, "status", "--porcelain");
    expect((await readdir(join(root, "markers"))).includes("clean")).toBe(true);
  });

  it("the passive artifact status works on a read-only worktree without touching real .git", async () => {
    const root = await newRoot("tr-ro-");
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "f.txt"), "aaaaa\n");
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "config", "filter.evil.clean", await marker(root, "clean", "cat"));
    await sameSizeEdit(repo, "f.txt", "bbbbb\n");
    await writeFile(join(repo, "new.pdf"), "x\n");
    // Read-only worktree root: git cannot write .git/index.lock in the real repository.
    await chmod(repo, 0o555);

    expect((await changedFiles(repo, window())).sort()).toEqual(["f.txt", "new.pdf"]);
    expect(await readdir(join(root, "markers"))).toEqual([]);
  });
});
