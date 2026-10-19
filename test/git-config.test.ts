import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { changedFiles } from "../server/artifacts";
import { detectCollisions } from "../server/collisions";
import { repoInfo } from "../server/git";

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Two worktrees of a repository whose .git/config, which an agent can write, names commands: an fsmonitor hook, a clean
 * filter and a merge driver. Each writes a marker file when git runs it. Both worktrees change f.txt and write an ignored file.
 */
async function hostileRepo() {
  const root = await mkdtemp(join(tmpdir(), "tr-hostile-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const markers = join(root, "markers");
  await mkdir(markers);
  const repo = join(root, "repo");
  sh(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "f.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil merge=evil\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
  const a = join(root, "a");
  const b = join(root, "b");
  sh(repo, "worktree", "add", "-q", "-b", "a", a);
  sh(repo, "worktree", "add", "-q", "-b", "b", b);
  await writeFile(join(a, "f.txt"), "one\nfrom a\nthree\n");
  await writeFile(join(b, "f.txt"), "one\nfrom b\nthree\n");
  await writeFile(join(a, "new.txt"), "untracked\n");
  // The private repository ignores what the repository ignores.
  await writeFile(join(repo, ".git/info/exclude"), "secret.log\n");
  await writeFile(join(a, "secret.log"), "a\n");
  await writeFile(join(b, "secret.log"), "b\n");

  const script = async (name: string, body: string) => {
    const path = join(root, `${name}.sh`);
    await writeFile(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const config = [
    ["core.fsmonitor", await script("fsmonitor", "exit 1")],
    ["filter.evil.clean", await script("clean", "cat")],
    ["merge.evil.driver", `${await script("merge", "exit 1")} %O %A %B`],
  ];
  // Set last: from here on, only the code under test runs git in this repository.
  for (const [key, value] of config) sh(repo, "config", key!, value!);
  return { root, markers, repo, a, b, ran: () => readdir(markers) };
}

describe("repository git config", () => {
  it("the conflict check runs no command the repository's config names", async () => {
    const { markers, a, b, ran } = await hostileRepo();
    const report = await detectCollisions(a, [{ agentId: "B", title: "B", cwd: b }]);
    expect(report.items.map((peer) => peer.files)).toEqual([[{ path: "f.txt", kind: "content" }]]);
    expect(await ran()).toEqual([]);

    // Control: git itself runs each of them in this repository.
    sh(a, "status", "--porcelain");
    sh(a, "commit", "-qam", "a");
    sh(b, "commit", "-qam", "b");
    try {
      sh(a, "merge-tree", "--write-tree", "a", "b");
    } catch {
      // exit 1: conflicts
    }
    expect((await readdir(markers)).sort()).toEqual(["clean", "fsmonitor", "merge"]);
  });

  it("git status and rev-parse on the real repository start no fsmonitor hook", async () => {
    const { a, ran } = await hostileRepo();
    expect(await repoInfo(a)).toMatchObject({ branch: "a" });
    const now = Date.now();
    expect((await changedFiles(a, { startedAtMs: now - 60_000, endedAtMs: now + 60_000 })).sort()).toEqual(["f.txt", "new.txt"]);
    // A clean filter can still run here, as in Paseo's own Changes view (OVERVIEW, Limits).
    expect((await ran()).filter((marker) => marker !== "clean")).toEqual([]);
  });
});
