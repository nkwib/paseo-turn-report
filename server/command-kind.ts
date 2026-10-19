import { shellSegments, type Segment } from "./shell";

export type CommandKind = "test" | "build" | "lint" | "other";

/**
 * What a command line runs, and whether the line's exit status is that run's: "unknown" when it is piped into
 * another command without pipefail, negated, sent to the background, or followed by `||` or by more commands
 * (a final `echo "exit: $?"` aside, which prints it).
 */
export interface CommandShape {
  kind: CommandKind;
  status: "own" | "unknown";
}
const own = (kind: CommandKind): CommandShape => ({ kind, status: "own" });

const RANK: Record<CommandKind, number> = { other: 0, lint: 1, build: 2, test: 3 };

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(cs|java|kt|swift)$|(^|\/)tests?\.(?:[cm]?[jt]sx?|py|sh)$/;
export const isTestFile = (path: string) => TEST_FILE_RE.test(path);

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** A script named for tests (test.mjs, run-tests.sh, test-e2e.js, e2e.mjs), or a test file itself. */
const TEST_SCRIPT_RE = /^(?:.*[^A-Za-z0-9])?(?:tests?|e2e|specs?)(?:[^A-Za-z0-9].*)?\.(?:[cm]?[jt]sx?|sh|py)$/;
const scriptFileKind = (path: string | undefined): CommandKind => (path !== undefined && (TEST_SCRIPT_RE.test(basename(path)) || isTestFile(path)) ? "test" : "other");

/** package.json script names: test, test:unit, build, typecheck, lint, format:check. */
function scriptKind(name: string | undefined): CommandKind | null {
  if (name === undefined) return null;
  if (/^test(?:[:-]|$)/.test(name)) return "test";
  if (/^(?:build|typecheck|type-check)(?:[:-]|$)/.test(name)) return "build";
  if (/^(?:lint|format:check)(?:[:-]|$)/.test(name)) return "lint";
  return null;
}

const BINS: Readonly<Record<string, CommandKind>> = {
  vitest: "test", jest: "test", mocha: "test", ava: "test", pytest: "test", "py.test": "test", tox: "test", nox: "test", rspec: "test", phpunit: "test", ctest: "test", unittest: "test",
  tsc: "build", "vue-tsc": "build", mypy: "build", pyright: "build",
  eslint: "lint", biome: "lint", ruff: "lint", "golangci-lint": "lint",
};
const SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, CommandKind>>>> = {
  cargo: { test: "test", nextest: "test", build: "build", check: "build", clippy: "lint" },
  go: { test: "test", build: "build", vet: "build" },
  deno: { test: "test" },
  mix: { test: "test" },
  dotnet: { test: "test" },
  gradle: { test: "test" },
  gradlew: { test: "test" },
  mvn: { test: "test" },
  mvnw: { test: "test" },
  playwright: { test: "test" },
};
/** pnpm, yarn and bun commands that run no project script or binary. */
const PM_BUILTINS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "ls", "list", "why", "outdated", "audit", "init", "create", "info", "view", "show", "publish", "pack", "link", "unlink", "config", "set", "get", "store", "dedupe", "import", "rebuild", "prune", "licenses", "patch", "setup", "env", "root", "bin", "cache", "help", "version", "login", "logout", "whoami", "fund", "doctor", "explain", "search"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words before the program that do not change what it is. */
const PREFIXES = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "nohup", "command", "exec", "builtin", "sudo", "env", "nice", "timeout", "xvfb-run"]);

const PREFIX_VALUE_FLAGS = new Set(["-u", "-n", "-s", "-k", "-C", "-g", "--signal", "--kill-after"]);
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file"]);
const PYTHON_VALUE_FLAGS = new Set(["-X", "-W"]);
const PM_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "--filter", "-F", "-w", "--workspace", "--cwd"]);
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "--with", "--project", "--directory", "--python", "--env-file", "--extra", "--group"]);
const MAKE_VALUE_FLAGS = new Set(["-C", "-f", "-j"]);
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();

/** Index of the first word after leading flags; `valueFlags` take the next word as their value. */
function skipFlags(argv: readonly string[], from: number, valueFlags: ReadonlySet<string> = NO_VALUE_FLAGS): number {
  let i = from;
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "-") i += valueFlags.has(argv[i]!) ? 2 : 1;
  return i;
}

/** What one simple command runs, after env assignments, prefixes such as `timeout 60` and runner wrappers such as npx. */
function programShape(argv: readonly string[], start = 0): CommandShape {
  let i = start;
  let negated = false;
  for (let word = argv[i]; word !== undefined && (ASSIGNMENT.test(word) || PREFIXES.has(word)); word = argv[i]) {
    i = ASSIGNMENT.test(word) ? i + 1 : skipFlags(argv, i + 1, PREFIX_VALUE_FLAGS);
    if (word === "timeout") i++; // its duration
    if (word === "!") negated = true;
  }
  const shape = programAt(argv, i);
  return negated ? { ...shape, status: "unknown" } : shape;
}

function programAt(argv: readonly string[], i: number): CommandShape {
  const program = argv[i];
  if (program === undefined) return own("other");
  const rest = i + 1;
  const name = /^python[\d.]*$/.test(basename(program)) ? "python" : basename(program);

  switch (name) {
    case "npx":
    case "bunx":
    case "pnpx":
    case "uvx":
      return programShape(argv, skipFlags(argv, rest, RUNNER_VALUE_FLAGS));
    case "uv":
    case "poetry":
    case "pipenv":
    case "pdm":
    case "hatch":
    case "rye":
      return argv[rest] === "run" ? programShape(argv, skipFlags(argv, rest + 1, RUNNER_VALUE_FLAGS)) : own("other");
    case "bundle":
      return argv[rest] === "exec" ? programShape(argv, rest + 1) : own("other");
    case "python": {
      const at = skipFlags(argv, rest, PYTHON_VALUE_FLAGS);
      const flags = argv.slice(rest, at);
      if (flags.at(-1) === "-m") return programShape(argv, at);
      return own(flags.includes("-c") ? "other" : scriptFileKind(argv[at]));
    }
    case "node":
    case "tsx":
    case "ts-node": {
      const at = skipFlags(argv, rest, NODE_VALUE_FLAGS);
      const flags = argv.slice(rest, at);
      if (flags.some((flag) => flag === "--test" || flag.startsWith("--test="))) return own("test");
      return own(flags.some((flag) => ["-e", "--eval", "-p", "--print"].includes(flag)) ? "other" : scriptFileKind(argv[at]));
    }
    case "sh":
    case "bash":
    case "zsh":
    case "dash": {
      const at = skipFlags(argv, rest, new Set(["-o", "+o"]));
      const inline = argv.slice(rest, at).some((flag) => /^-[a-z]*c[a-z]*$/.test(flag));
      if (inline) return argv[at] === undefined ? own("other") : commandShape(argv[at]!);
      return own(scriptFileKind(argv[at]));
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageManagerShape(name, argv, rest);
    case "make": {
      const target = argv[skipFlags(argv, rest, MAKE_VALUE_FLAGS)];
      if (target === "test") return own("test");
      return own(target === undefined || target === "build" || target === "all" ? "build" : "other");
    }
    case "prettier":
      return own(argv.slice(rest).some((arg) => arg === "--check" || arg === "-c") ? "lint" : "other");
  }
  const bin = BINS[name];
  if (bin) return own(bin);
  const sub = argv[skipFlags(argv, rest)];
  const subcommand = sub === undefined ? undefined : SUBCOMMANDS[name]?.[sub];
  if (subcommand) return own(subcommand);
  return own(program.includes("/") ? scriptFileKind(program) : "other");
}

function packageManagerShape(name: string, argv: readonly string[], from: number): CommandShape {
  let i = skipFlags(argv, from, PM_VALUE_FLAGS);
  if (name === "yarn" && argv[i] === "workspace") i = skipFlags(argv, i + 2, PM_VALUE_FLAGS);
  const sub = argv[i];
  if (sub === undefined) return own("other");
  if (sub === "run" || sub === "run-script") return own(scriptKind(argv[skipFlags(argv, i + 1, PM_VALUE_FLAGS)]) ?? "other");
  if (sub === "exec" || sub === "x" || sub === "dlx") return programShape(argv, skipFlags(argv, i + 1, RUNNER_VALUE_FLAGS));
  if (name === "npm") return own(sub === "test" || sub === "t" || sub === "tst" ? "test" : "other");
  if (name === "bun" && sub === "test") return own("test");
  if (name === "bun" && /[./]/.test(sub)) return own(scriptFileKind(sub));
  if (PM_BUILTINS.has(sub)) return own("other");
  // pnpm, yarn and bun run a script or a binary by name: `pnpm test`, `yarn jest`, `pnpm vitest run`.
  const script = scriptKind(sub);
  return script ? own(script) : programShape(argv, i);
}

const isPipefail = ({ argv }: Segment) =>
  (argv[0] === "set" && argv.includes("pipefail") && argv.some((arg) => /^-[a-z]*o[a-z]*$/.test(arg))) || (argv[0] === "setopt" && argv.some((arg) => /^pipe_?fail$/i.test(arg)));

const printsStatus = (rest: readonly Segment[]) => rest.length === 1 && rest[0]!.argv[0] === "echo" && rest[0]!.argv.some((arg) => arg.includes("$?"));

/** Does the exit status of `segments[index]` reach the end of the line? */
function statusAt(segments: readonly Segment[], index: number): CommandShape["status"] {
  const pipefail = segments.slice(0, index).some(isPipefail);
  for (let j = index; j < segments.length; j++) {
    const next = segments[j]!.next;
    if (next === null) return "own";
    if (next === "||" || next === "&" || (next === "|" && !pipefail)) return "unknown";
    if (next === ";") return printsStatus(segments.slice(j + 1)) ? "own" : "unknown";
  }
  return "own";
}

/** By the program each segment runs, never by a word anywhere in the line; the highest kind wins (test, build, lint), and its last run speaks for the line. */
export function commandShape(command: string): CommandShape {
  const segments = shellSegments(command);
  let best: { shape: CommandShape; index: number } | null = null;
  segments.forEach(({ argv }, index) => {
    const shape = programShape(argv);
    if (shape.kind !== "other" && (!best || RANK[shape.kind] >= RANK[best.shape.kind])) best = { shape, index };
  });
  if (!best) return own("other");
  const { shape, index } = best as { shape: CommandShape; index: number };
  return { kind: shape.kind, status: shape.status === "own" ? statusAt(segments, index) : "unknown" };
}

export const commandKind = (command: string): CommandKind => commandShape(command).kind;
