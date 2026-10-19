import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { changedFiles } from "../server/artifacts";
import { detectCollisions } from "../server/collisions";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: "pipe" });
const window = () => {
  const now = Date.now();
  return { startedAtMs: now - 60_000, endedAtMs: now + 60_000 };
};

/** A superproject with one submodule whose own config names a clean filter that marks when it runs. */
async function superproject(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const markers = join(root, "markers");
  await mkdir(markers);
  const source = join(root, "source");
  git(root, "init", "-q", source);
  await writeFile(join(source, "f.txt"), "before\n");
  await writeFile(join(source, ".gitattributes"), "*.txt filter=mark\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "fixture");
  const repo = join(root, "repo");
  git(root, "init", "-q", repo);
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
  git(repo, "commit", "-qm", "fixture");
  const filter = join(root, "filter.sh");
  await writeFile(filter, `#!/bin/sh\ntouch '${join(markers, "clean")}'\ncat\n`);
  await chmod(filter, 0o755);
  git(join(repo, "sub"), "config", "filter.mark.clean", filter);
  return { root, source, repo, markers, ran: () => readdir(markers) };
}

describe("passive reads and submodules", () => {
  it("passive status does not enter a submodule whose config names a clean filter", async () => {
    const { repo, ran } = await superproject("tr-submodule-");
    await writeFile(join(repo, "sub/f.txt"), "after!\n");
    await changedFiles(repo, window());
    expect(await ran()).toEqual([]);
    // Control: ordinary parent status enters the submodule and starts its filter.
    git(repo, "status", "--porcelain=v1");
    expect(await ran()).toEqual(["clean"]);
  });

  it("the conflict check does not enter a submodule whose config names a clean filter", async () => {
    const { root, repo, ran } = await superproject("tr-submodule-col-");
    // A peer worktree of the same superproject, each with a dirty submodule working tree.
    const peer = join(root, "peer");
    git(repo, "worktree", "add", "-q", "-b", "peer", peer);
    git(peer, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    git(join(peer, "sub"), "config", "filter.mark.clean", join(root, "filter.sh"));
    await writeFile(join(repo, "sub/f.txt"), "self-dirty\n");
    await writeFile(join(peer, "sub/f.txt"), "peer-dirty\n");
    // Also make a real superproject-level conflict so the check does meaningful work.
    await writeFile(join(repo, "top.txt"), "self\n");
    await writeFile(join(peer, "top.txt"), "peer\n");
    await detectCollisions(repo, [{ agentId: "P", title: "P", cwd: peer }]);
    expect(await ran()).toEqual([]);
  });
});
