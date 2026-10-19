import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { approveCheckRpc, recentReportsRpc, rerunRpc, settingsDefinition } from "../shared/report";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILER_FILES = ["compiler.ts", "compiler-imports.ts", "plugin-sdk-specifiers.ts"];
const PLUGINS_DIR = "packages/server/src/server/plugins";

function findRuntimePlugins(prefix: string): string {
  const roots = [join(prefix, "node_modules/@getpaseo/server"), prefix];
  const candidates = roots.flatMap((root) => [join(root, "dist/server/server/plugins"), join(root, "dist/server/plugins")]);
  const found = candidates.find((dir) => ["compiler.js", "manifest.js", "bundle-evaluator.js"].every((file) => existsSync(join(dir, file))));
  if (!found) throw new Error(`PASEO_RUNTIME has no released Paseo compiler and evaluator: ${prefix}`);
  return found;
}

function findPaseoSource(): string | null {
  const candidates = process.env.PASEO_SOURCE ? [process.env.PASEO_SOURCE] : [resolve(ROOT, "../paseo-main"), resolve(ROOT, "../worktrees/paseo-main")];
  const found = candidates.find((dir) => existsSync(join(dir, PLUGINS_DIR, "compiler.ts")) && existsSync(join(dir, "node_modules/.bin/tsx"))) ?? null;
  if (process.env.PASEO_SOURCE && !found) throw new Error(`PASEO_SOURCE is not a dependency-ready Paseo checkout: ${process.env.PASEO_SOURCE}`);
  return found;
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

const RUNTIME = process.env.PASEO_RUNTIME ? findRuntimePlugins(process.env.PASEO_RUNTIME) : null;
const PASEO = RUNTIME ? null : findPaseoSource();
const IN_GIT = succeeds(() => gitOut(ROOT, ["rev-parse", "--verify", "HEAD"]));
const SKIP = !RUNTIME && !PASEO ? "no host: set PASEO_RUNTIME to an installed CLI prefix or PASEO_SOURCE to a dependency-ready checkout" : !IN_GIT ? "not a Git checkout of the plugin" : null;
if (process.env.PASEO_REQUIRE_INSTALL === "1" && SKIP) throw new Error(`Host validation is required: ${SKIP}`);

/** The source checkout is always tested. Explicit extra refs must exist rather than silently skip. */
function compilerRefs(paseo: string): { ref: string; present: boolean }[] {
  const refs = process.env.PASEO_REFS?.split(",").map((ref) => ref.trim()).filter(Boolean) ?? [];
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
    NODE_PATH: [join(paseo, "packages/server/node_modules"), join(paseo, "node_modules")].join(delimiter),
    // contribute() creates its data folder: keep it inside the temp folder.
    PASEO_HOME: join(out, "home"),
  };
  const loader = createRequire(join(paseo, "package.json")).resolve("tsx");
  execFileSync(process.execPath, ["--import", pathToFileURL(loader).href, join(ROOT, "test/paseo-compile.mjs"), compilerDir, join(paseo, PLUGINS_DIR), pluginDir, out], { cwd: paseo, env, stdio: "pipe", timeout: 120_000 });
  return JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as { error?: string; clientBytes: number; serverBytes: number; handlers: string[]; hooks: string[]; settings: string[] };
}

function compileRuntime(plugins: string, pluginDir: string): ReturnType<typeof compile> {
  const out = temp("turn-report-runtime-");
  execFileSync(process.execPath, [join(ROOT, "test/paseo-compile.mjs"), plugins, plugins, pluginDir, out], {
    cwd: ROOT,
    env: { ...process.env, PASEO_HOME: join(out, "home") },
    stdio: "pipe",
    timeout: 120_000,
  });
  return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
}

describe("Git install", () => {
  it.skipIf(SKIP !== null)(`Paseo's own compiler accepts the committed tree with no node_modules${SKIP ? ` (skipped: ${SKIP})` : ""}`, () => {
    const plugin = archiveHead();
    expect(existsSync(join(plugin, "node_modules"))).toBe(false);
    const expected = { error: undefined, client: true, handlers: [approveCheckRpc.name, recentReportsRpc.name, rerunRpc.name].sort(), hooks: ["agent.turn_ended", "agent.turn_started"], settings: [settingsDefinition.id] };
    const check = (result: ReturnType<typeof compile>, label: string) => {
      const got = { error: result.error, client: (result.clientBytes ?? 0) > 0, handlers: (result.handlers ?? []).sort(), hooks: [ ...(result.hooks ?? []) ].sort(), settings: result.settings ?? [] };
      expect.soft(got, label).toEqual(expected);
    };
    if (RUNTIME) {
      check(compileRuntime(RUNTIME, plugin), `released compiler at ${RUNTIME}`);
      return;
    }
    const paseo = PASEO!;
    const targets = [{ ref: null as string | null, present: true }, ...compilerRefs(paseo)];
    for (const { ref, present } of targets) expect(present, `requested Paseo ref ${ref} must exist in ${paseo}`).toBe(true);
    for (const { ref } of targets) {
      const label = ref ?? "checkout";
      const result = compile(paseo, compilerAt(paseo, ref), plugin);
      check(result, `compiler at ${label}`);
    }
  }, 180_000);
});
