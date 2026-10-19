import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { changedFiles } from "../server/artifacts";
import { detectCollisions } from "../server/collisions";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
});
const window = () => ({ startedAtMs: Date.now() - 60_000, endedAtMs: Date.now() + 60_000 });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tr-git-semantics-"));
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "f.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return { root, repo };
}

it("preserves safe line-ending settings without importing executable global config", async () => {
  const { root, repo } = await fixture();
  const global = join(root, "global.gitconfig");
  await writeFile(global, "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = false\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", global);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await writeFile(join(repo, "f.txt"), "one\r\ntwo\r\nthree\r\n");
  expect(await changedFiles(repo, window())).toEqual([]);
});

it("does not invent a conflict between independent edits in CRLF worktrees", async () => {
  const { root, repo } = await fixture();
  git(repo, "config", "core.autocrlf", "true");
  const a = join(root, "a");
  const b = join(root, "b");
  git(repo, "worktree", "add", "-q", "-b", "a", a);
  git(repo, "worktree", "add", "-q", "-b", "b", b);
  await writeFile(join(a, "f.txt"), "from a\r\ntwo\r\nthree\r\n");
  await writeFile(join(b, "f.txt"), "one\r\ntwo\r\nfrom b\r\n");
  expect((await detectCollisions(a, [{ agentId: "B", title: "B", cwd: b }])).items).toEqual([]);
});

it("preserves a custom global ignore file without importing the rest of that config", async () => {
  const { root, repo } = await fixture();
  const ignore = join(root, "ignore");
  await writeFile(ignore, "private.log\n");
  const global = join(root, "global.gitconfig");
  await writeFile(global, `[core]\n\texcludesFile = "${ignore}"\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", global);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await writeFile(join(repo, "private.log"), "ignored\n");
  expect(await changedFiles(repo, window())).toEqual([]);
});
