import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { changedFiles } from "../server/artifacts";

it("does not turn a racily clean real index entry into a clean copied entry", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tr-racy-index-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  const file = join(repo, "f.txt");
  const index = join(repo, ".git/index");
  await writeFile(file, "before\n");
  git("-c", "index.version=2", "add", "f.txt");
  git("commit", "-qm", "fixture");
  await writeFile(file, "after!\n");
  const recent = new Date(Date.now() - 1000);
  await utimes(file, recent, recent);
  const current = await stat(file, { bigint: true });
  const bytes = await readFile(index);
  expect(bytes.readUInt32BE(4)).toBe(2);
  expect(bytes.readUInt32BE(8)).toBe(1);
  // Reproduce a same-tick stat cache: timestamps and size match, but the indexed blob is still "before".
  for (const [offset, ns] of [[12, current.ctimeNs], [20, current.mtimeNs]] as const) {
    bytes.writeUInt32BE(Number(ns / 1_000_000_000n), offset);
    bytes.writeUInt32BE(Number(ns % 1_000_000_000n), offset + 4);
  }
  createHash("sha1").update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  await writeFile(index, bytes);
  await utimes(index, recent, recent);
  // Git rehashes this entry because its timestamp is at least as recent as the index timestamp.
  expect(git("status", "--porcelain=v1").trim()).toBe("M f.txt");
  const now = Date.now();
  expect(await changedFiles(repo, { startedAtMs: now - 60_000, endedAtMs: now + 60_000 })).toEqual(["f.txt"]);
});
