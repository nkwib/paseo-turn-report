import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { dataDirectory, ensurePrivateDirectory } from "../server/store";

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "tr-dir-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("data directory", () => {
  it("is a per-user folder, never the shared temp dir", () => {
    expect(dataDirectory({}, "/home/u")).toBe("/home/u/.local/state/paseo-turn-report");
    expect(dataDirectory({ XDG_STATE_HOME: "/xdg" }, "/home/u")).toBe("/xdg/paseo-turn-report");
    expect(dataDirectory({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/state/paseo-turn-report");
    expect(dataDirectory({ PASEO_HOME: "/home/u/.paseo" }, "/home/u")).toBe("/home/u/.paseo/plugin-data/turn-report");
    expect(dataDirectory({ PASEO_HOME: "~/.paseo-dev" }, "/home/u")).toBe("/home/u/.paseo-dev/plugin-data/turn-report");
    expect(dataDirectory({ PASEO_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/state/paseo-turn-report");
  });

  it("creates the folder private, tightens one of ours, and refuses one owned by someone else or a symlink", async () => {
    const root = await tempDir();
    const dir = join(root, "state", "paseo-turn-report");
    await ensurePrivateDirectory(dir);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);

    await chmod(dir, 0o777);
    await ensurePrivateDirectory(dir);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);

    await expect(ensurePrivateDirectory(dir, process.getuid!() + 1)).rejects.toThrow(/not owned by/);

    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    const link = join(root, "link");
    await symlink(target, link);
    await expect(ensurePrivateDirectory(link)).rejects.toThrow(/not a directory/);
  });
});
