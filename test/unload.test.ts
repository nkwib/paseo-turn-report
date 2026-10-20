import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import contribute from "../index.server";
import { DEFAULT_SETTINGS } from "../shared/report";
import type { PaseoApi } from "../server/host-types";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (condition()) return true;
  return condition();
}

/** The plugin as Paseo loads it: contribute() with a server that records hooks, and the cleanup it returns. */
function load(settings: object) {
  const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { ...DEFAULT_SETTINGS, ...settings } }) }),
    on: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => void hooks.set(name, fn),
    handle: () => {},
  };
  const cleanup = contribute(server as never) as () => Promise<void>;
  return { hooks, cleanup };
}

describe("plugin unload", () => {
  it("stops a running check when the plugin stops or reloads (review S7)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-unload-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv("PASEO_HOME", join(root, "home"));
    onTestFinished(() => void vi.unstubAllEnvs());
    const pidFile = join(root, "check.pid");
    const { hooks, cleanup } = load({ checkCommand: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, collisions: false, artifacts: false });
    const paseo = { agents: { list: async () => ({ entries: [] }), ref: () => ({ status: "idle", refresh: async () => null, send: async () => {}, timeline: { append: async () => ({ seq: 1, epoch: "e" }) } }) } } as unknown as PaseoApi;
    const agent = { id: "A", cwd: root, title: "A", workspaceId: "ws", parentAgentId: null, provider: "mock" };
    await hooks.get("agent.turn_started")!({ agent, turnId: "t1" }, { paseo });
    const timeline = [{ type: "user_message", text: "go", messageId: "u" }, { type: "tool_call", callId: "c", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "ls", exitCode: 0 } }, { type: "assistant_message", text: "Done." }];
    await hooks.get("agent.turn_ended")!({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline }, { paseo });
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    onTestFinished(() => void (isAlive(pid) && process.kill(pid, "SIGKILL")));
    expect(isAlive(pid)).toBe(true);

    await cleanup();
    expect(await until(() => !isAlive(pid), 1_000)).toBe(true);
  });
});
