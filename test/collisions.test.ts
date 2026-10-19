import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { detectCollisions } from "../server/collisions";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) n++;
  return n;
}

describe("detectCollisions (real git)", () => {
  let root: string;
  let a: string;
  let b: string;
  let c: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tr-col-"));
    const repo = join(root, "repo");
    sh(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
    await writeFile(join(repo, "README.md"), "demo\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    a = join(root, "wt-a");
    b = join(root, "wt-b");
    c = join(root, "wt-c");
    sh(repo, "worktree", "add", "-q", "-b", "a", a);
    sh(repo, "worktree", "add", "-q", "-b", "b", b);
    sh(repo, "worktree", "add", "-q", "-b", "c", c);
    // a and b both rewrite add() (uncommitted) and both create notes.md (untracked); c edits README only.
    await writeFile(join(a, "math.js"), "export const add = (a, b) => Number(a) + Number(b);\nexport const sub = (a, b) => a - b;\n");
    await writeFile(join(b, "math.js"), "export const add = (x, y) => x + y; // b\nexport const sub = (a, b) => a - b;\n");
    await writeFile(join(a, "notes.md"), "from a\n");
    await writeFile(join(b, "notes.md"), "from b\n");
    await writeFile(join(c, "README.md"), "demo from c\n");
    sh(c, "commit", "-qam", "c readme");
    return () => rm(root, { recursive: true, force: true });
  });

  it("lists files that would conflict with each peer and leaves every worktree and index untouched", async () => {
    const common = join(root, "repo/.git");
    const before = {
      objects: await countFiles(join(common, "objects")),
      statusA: sh(a, "status", "--porcelain"),
      statusB: sh(b, "status", "--porcelain"),
      indexA: (await stat(join(common, "worktrees/wt-a/index"))).mtimeMs,
      indexB: await readFile(join(common, "worktrees/wt-b/index")),
    };
    const report = await detectCollisions(a, [
      { agentId: "agent-b", title: "B agent", cwd: b },
      { agentId: "agent-c", title: "C agent", cwd: c },
      { agentId: "agent-a2", title: "same worktree", cwd: a },
      { agentId: "elsewhere", title: "not a repo", cwd: tmpdir() },
    ]);
    expect(report.state).toBe("done");
    expect(report.peersChecked).toBe(2);
    expect(report.items).toEqual([
      { agentId: "agent-b", agentTitle: "B agent", branch: "b", files: [{ path: "math.js", kind: "content" }, { path: "notes.md", kind: "add/add" }], moreFiles: 0 },
    ]);
    expect(await countFiles(join(common, "objects"))).toBe(before.objects);
    expect(sh(a, "status", "--porcelain")).toBe(before.statusA);
    expect(sh(b, "status", "--porcelain")).toBe(before.statusB);
    expect((await stat(join(common, "worktrees/wt-a/index"))).mtimeMs).toBe(before.indexA);
    expect(await readFile(join(common, "worktrees/wt-b/index"))).toEqual(before.indexB);
  });

  it("reports no peers outside the repository", async () => {
    const report = await detectCollisions(a, []);
    expect(report).toMatchObject({ state: "done", peersChecked: 0, items: [] });
  });

  it("pairs the main worktree with a linked one when the path goes through a symlink (macOS $TMPDIR)", async () => {
    // git gives the main worktree's common dir as ".git" and a linked worktree's as an absolute real path.
    const link = join(root, "link");
    await symlink(root, link);
    const main = join(link, "repo");
    expect(await detectCollisions(main, [{ agentId: "agent-a", title: "A agent", cwd: a }])).toMatchObject({ state: "done", peersChecked: 1, note: null });
    expect(await detectCollisions(a, [{ agentId: "main", title: "main agent", cwd: main }])).toMatchObject({ state: "done", peersChecked: 1, note: null });
  });

  it("skips outside git", async () => {
    expect((await detectCollisions(tmpdir(), [])).state).toBe("skipped");
  });
});
