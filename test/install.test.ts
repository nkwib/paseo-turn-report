import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { approveCheckRpc, recentReportsRpc, rerunRpc, settingsDefinition } from "../shared/report";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILER_FILES = ["compiler.ts", "compiler-imports.ts", "plugin-sdk-specifiers.ts"];
const PLUGINS_DIR = "packages/server/src/server/plugins";

function findPaseoSource(): string | null {
  const candidates = process.env.PASEO_SOURCE ? [process.env.PASEO_SOURCE] : [resolve(ROOT, "../paseo-main"), resolve(ROOT, "../worktrees/paseo-main")];
  return candidates.find((dir) => existsSync(join(dir, PLUGINS_DIR, "compiler.ts")) && existsSync(join(dir, "node_modules/.bin/tsx"))) ?? null;
}

const gitOut = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const succeeds = (fn: () => unknown) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const PASEO = findPaseoSource();
const IN_GIT = succeeds(() => gitOut(ROOT, ["rev-parse", "--verify", "HEAD"]));
const SKIP = !PASEO ? "no Paseo checkout: set PASEO_SOURCE to a getpaseo/paseo checkout with node_modules installed" : !IN_GIT ? "not a Git checkout of the plugin" : null;

/** The manifest's minimum Paseo version, and the latest stable at release time, unless PASEO_REFS lists others. */
function compilerRefs(paseo: string): { ref: string; present: boolean }[] {
  const minimum = /(\d+\.\d+\.\d+)/.exec(JSON.parse(readFileSync(join(ROOT, "paseo-plugin.json"), "utf8")).requirements.paseo)?.[1];
  const refs = process.env.PASEO_REFS ? process.env.PASEO_REFS.split(",").map((ref) => ref.trim()).filter(Boolean) : [`v${minimum}`, "v0.11.4"];
  return refs.map((ref) => ({ ref, present: succeeds(() => gitOut(paseo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])) }));
}

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** What a Git install gets: the committed tree, no node_modules and no build step (the manifest has none). */
function archiveHead(): string {
  const dir = temp("turn-report-archive-");
  const tar = join(dir, "head.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: ROOT });
  mkdirSync(join(dir, "plugin"));
  execFileSync("tar", ["-xf", tar, "-C", join(dir, "plugin")]);
  return join(dir, "plugin");
}

/** The compiler as of `ref`, read with `git show` so the checkout is never changed. */
function compilerAt(paseo: string, ref: string | null): string {
  if (ref === null) return join(paseo, PLUGINS_DIR);
  const dir = temp("turn-report-compiler-");
  for (const file of COMPILER_FILES) writeFileSync(join(dir, file), gitOut(paseo, ["show", `${ref}:${PLUGINS_DIR}/${file}`]));
  return dir;
}

function compile(paseo: string, compilerDir: string, pluginDir: string) {
  const out = temp("turn-report-compile-");
  const env = {
    ...process.env,
    // The extracted compiler resolves esbuild and typescript from the checkout.
    NODE_PATH: [join(paseo, "packages/server/node_modules"), join(paseo, "node_modules")].join(":"),
    // contribute() creates its data folder: keep it inside the temp folder.
    PASEO_HOME: join(out, "home"),
  };
  execFileSync(join(paseo, "node_modules/.bin/tsx"), [join(ROOT, "test/paseo-compile.mts"), compilerDir, join(paseo, PLUGINS_DIR), pluginDir, out], { cwd: paseo, env, stdio: "pipe" });
  return JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { error?: string; clientBytes: number; serverBytes: number; handlers: string[]; hooks: string[]; settings: string[] };
}

describe("Git install", () => {
  it.skipIf(SKIP !== null)(`Paseo's own compiler accepts the committed tree with no node_modules${SKIP ? ` (skipped: ${SKIP})` : ""}`, () => {
    const paseo = PASEO!;
    const plugin = archiveHead();
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
    const targets = [{ ref: null as string | null, present: true }, ...compilerRefs(paseo)];
    const expected = { error: undefined, client: true, handlers: [approveCheckRpc.name, recentReportsRpc.name, rerunRpc.name].sort(), hooks: ["agent.turn_ended", "agent.turn_started"], settings: [settingsDefinition.id] };
    for (const { ref, present } of targets) {
      const label = ref ?? "checkout";
      if (!present) {
        console.warn(`[install.test] ${label} is not in ${paseo}, not compiled against it`);
        continue;
      }
      const result = compile(paseo, compilerAt(paseo, ref), plugin);
      const got = { error: result.error, client: (result.clientBytes ?? 0) > 0, handlers: (result.handlers ?? []).sort(), hooks: (result.hooks ?? []).sort(), settings: result.settings ?? [] };
      expect.soft(got, `compiler at ${label}`).toEqual(expected);
    }
  }, 180_000);
});
