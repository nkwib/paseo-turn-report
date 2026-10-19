import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TAIL_CHARS } from "../shared/report";
import { externalEnv } from "./env";

/** Keep only the last `max` characters of output while streaming (bounded memory for chatty test runners). */
const MAX_CAPTURE_CHARS = 64 * 1024;

export interface CheckCommand {
  command: string;
  source: "setting" | "paseo.json scripts.verify" | "paseo.json scripts.check" | "paseo.json scripts.test";
}

export async function resolveCheckCommand(root: string, override: string): Promise<CheckCommand | null> {
  if (override.trim()) return { command: override.trim(), source: "setting" };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, "paseo.json"), "utf8"));
  } catch {
    return null;
  }
  const scripts = (raw as { scripts?: Record<string, { command?: unknown } | undefined> } | null)?.scripts ?? {};
  for (const name of ["verify", "check", "test"] as const) {
    const command = scripts[name]?.command;
    if (typeof command === "string" && command.trim()) return { command: command.trim(), source: `paseo.json scripts.${name}` };
  }
  return null;
}

export interface CheckResult {
  exitCode: number;
  durationMs: number;
  tail: string;
  timedOut: boolean;
  /** Stopped by `signal`: the plugin is stopping or reloading. */
  stopped: boolean;
}

/** After the shell exits, how long output from its leftovers may still arrive before the pipes are cut. */
const EXIT_GRACE_MS = 300;

const killGroup = (pid: number | undefined) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
};

export function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((done) => {
    if (signal?.aborted) return done({ exitCode: 137, durationMs: 0, tail: "", timedOut: false, stopped: true });
    // detached: the check gets its own process group, so a timeout or its end stops everything it started there.
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...externalEnv(), CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    let timedOut = false;
    let stopped = false;
    let exitCode: number | null = null;
    let settled = false;
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_CAPTURE_CHARS) out = out.slice(-MAX_CAPTURE_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      // Settle even if no exit arrives (the group kill failed).
      grace = setTimeout(() => finish(exitCode ?? 137), EXIT_GRACE_MS * 2);
    }, timeoutMs);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", stop);
      // Leftovers in the group (`server &`) stop with the check. A process that left the group keeps running,
      // but the check no longer waits for the output pipe it holds.
      killGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ exitCode: code, durationMs: Date.now() - started, tail: tailOf(out), timedOut, stopped });
    };
    // The group runs in its own session: it outlives the plugin process unless killed here.
    const stop = () => {
      stopped = true;
      finish(137);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      append(Buffer.from(String(error)));
      finish(127);
    });
    // The shell's exit ends the check; `close` waits for every holder of the pipes, which can be never.
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : 1);
      clearTimeout(grace);
      grace = setTimeout(() => finish(exitCode!), EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => finish(exitCode ?? code ?? (signal ? 128 : 1)));
  });
}

export function tailOf(output: string, max = MAX_TAIL_CHARS): string {
  // Strip ANSI escapes so the card and the follow-up stay readable.
  const clean = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n").trimEnd();
  if (clean.length <= max) return clean;
  const cut = clean.slice(-max);
  const newline = cut.indexOf("\n");
  return `...${newline >= 0 && newline < 200 ? cut.slice(newline) : cut}`;
}

/** A Markdown fence longer than any backtick run in `text`, so the output cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function followUpMessage(input: { command: string; exitCode: number; attempt: number; maxAttempts: number; tail: string }): string {
  const fence = fenceFor(input.tail);
  return [
    `Turn report: the project check failed (attempt ${input.attempt} of ${input.maxAttempts}).`,
    `\`${input.command}\` exited with code ${input.exitCode}. Last output:`,
    "",
    fence,
    input.tail,
    fence,
    "",
    "Fix the cause, then stop. The check runs again when your turn ends.",
  ].join("\n");
}
