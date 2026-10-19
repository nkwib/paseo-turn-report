import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { followUpMessage, resolveCheckCommand, runCheck, tailOf } from "../server/verify";

describe("resolveCheckCommand", () => {
  it("prefers the setting, then verify, check, test from paseo.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tr-ver-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    expect(await resolveCheckCommand(dir, "")).toBeNull();
    await writeFile(join(dir, "paseo.json"), JSON.stringify({ scripts: { test: { command: "npm test" }, check: { command: "npm run check" } } }));
    expect(await resolveCheckCommand(dir, "")).toEqual({ command: "npm run check", source: "paseo.json scripts.check" });
    expect(await resolveCheckCommand(dir, " make ci ")).toEqual({ command: "make ci", source: "setting" });
  });
});

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "tr-ver-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const pidIn = async (dir: string) => Number((await readFile(join(dir, "bg.pid"), "utf8")).trim());
/** Signal 0 checks for the process; give a SIGKILLed one a moment to be reaped. */
async function alive(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

describe("runCheck", () => {
  it("captures exit code and output tail", async () => {
    const result = await runCheck("echo hello; echo boom >&2; exit 3", tmpdir(), 5_000);
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain("hello");
    expect(result.tail).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  it("kills the whole process tree on timeout", async () => {
    const dir = await tempDir();
    const started = Date.now();
    const result = await runCheck("sleep 30 & echo $! > bg.pid; sleep 30; wait", dir, 300);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await alive(await pidIn(dir))).toBe(false);
  });

  it("ends on the shell's exit: a background job holding the output does not keep it running (review S6)", async () => {
    const started = Date.now();
    const result = await runCheck("sleep 5 & echo ok", tmpdir(), 3_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, tail: "ok" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not wait for a process that left the check's process group and kept its output", async () => {
    // A detached child gets a new session, out of reach of the group kill, and inherits the output pipe.
    const escape = `${JSON.stringify(process.execPath)} -e "require('child_process').spawn('sleep', ['4'], { detached: true, stdio: 'inherit' }).unref()"`;
    const started = Date.now();
    const result = await runCheck(`${escape}; echo started`, tmpdir(), 1_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, tail: "started" });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("drops the daemon's runtime-control variables and PASEO_* from the check's env, as Paseo does for user commands (review S8)", async () => {
    const daemon = { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", ESBUILD_BINARY_PATH: "/x/esbuild", PASEO_NODE_ENV: "production", PASEO_DESKTOP_MANAGED: "1", PASEO_SUPERVISED: "1", PASEO_PASSWORD: "secret", PASEO_HOME: "/x/.paseo" };
    for (const [key, value] of Object.entries({ ...daemon, TR_KEEP_ME: "kept" })) vi.stubEnv(key, value);
    onTestFinished(() => void vi.unstubAllEnvs());
    const result = await runCheck("env | grep -E '^(ELECTRON_|ESBUILD_|PASEO_|TR_KEEP_ME=|CI=)'", tmpdir(), 5_000);
    const names = result.tail.split("\n").map((line) => line.split("=")[0]);
    expect(names.filter((name) => name! in daemon)).toEqual([]);
    expect(result.tail).toContain("TR_KEEP_ME=kept");
    expect(result.tail).toContain("CI=1");
  });

  it("stops what the check left running in its process group once it ends", async () => {
    const dir = await tempDir();
    const result = await runCheck("sleep 30 >/dev/null 2>&1 & echo $! > bg.pid", dir, 5_000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await alive(await pidIn(dir))).toBe(false);
  });
});

describe("tailOf", () => {
  it("strips ANSI and keeps the end, cut at a line boundary", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailOf(`\u001b[31m${long}\u001b[0m`, 100);
    expect(tail.startsWith("...\n")).toBe(true);
    expect(tail.endsWith("line 499")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(104);
  });
});

describe("followUpMessage", () => {
  it("fences the output with more backticks than any run inside it", () => {
    const tail = "FAIL\n```js\nexpect(sum(1, 2)).toBe(3)\n```\nsee ```` for details";
    const lines = followUpMessage({ command: "npm test", exitCode: 1, attempt: 1, maxAttempts: 2, tail }).split("\n");
    const open = lines.findIndex((line) => /^`{3,}$/.test(line));
    expect(lines[open]).toBe("`````");
    expect(lines.slice(open + 1, open + 1 + tail.split("\n").length).join("\n")).toBe(tail);
    expect(lines[open + 1 + tail.split("\n").length]).toBe("`````");
    // No backticks: the usual three.
    expect(followUpMessage({ command: "npm test", exitCode: 1, attempt: 1, maxAttempts: 2, tail: "FAIL" })).toContain("\n```\nFAIL\n```\n");
  });

  it("names the attempt and the command", () => {
    const text = followUpMessage({ command: "npm test", exitCode: 1, attempt: 1, maxAttempts: 3, tail: "FAIL" });
    expect(text).toContain("attempt 1 of 3");
    expect(text).toContain("`npm test` exited with code 1");
  });
});
