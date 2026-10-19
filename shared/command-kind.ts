import { shellSegments, type Segment } from "./shell";

export type CommandKind = "test" | "build" | "lint" | "other";

/** What a command line runs, and whether the line's exit status alone settles that run ("own"). */
export interface CommandShape {
  kind: CommandKind;
  status: "own" | "unknown";
}

/**
 * One test, build or lint run on a command line. `status` is "own" when `exitCode` is that run's (null if the call
 * reported none); "unknown" when it may not have run or its status did not reach the end of the line. `cwd` is the
 * directory it was sent to (cd, --prefix, -C), as written and unresolved; null when unchanged.
 */
export interface CommandRun extends CommandShape {
  exitCode: number | null;
  cwd: string | null;
}

/** The main run (the highest kind, its last run), every run in order, and whether the line may change files besides. */
export interface CommandResult extends CommandRun {
  runs: CommandRun[];
  writes: boolean;
}

const RANK: Record<CommandKind, number> = { other: 0, lint: 1, build: 2, test: 3 };

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(cs|java|kt|swift)$|(^|\/)tests?\.(?:[cm]?[jt]sx?|py|sh)$/;
export const isTestFile = (path: string) => TEST_FILE_RE.test(path);

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".");
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
const PREFIXES = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "nohup", "command", "exec", "builtin", "sudo", "env", "nice", "timeout", "xvfb-run"]);
/** Shell syntax this reader does not follow: a run inside it may be skipped or repeated. */
const CONTROL = new Set(["if", "then", "else", "elif", "fi", "while", "until", "for", "do", "done", "case", "esac", "select", "function", "trap"]);
/** `name() { ...; }` defines a function: its body runs only when called. */
const FUNCTION_DEFINITION = /(?:^|[;&|\n({]\s*)[A-Za-z_][\w.:-]*\s*\(\s*\)/;
/** Flags with which a runner lists, describes or plans its work instead of doing it. */
const NO_RUN_FLAGS = new Set(["--help", "--version", "--dry-run", "--listTests", "--list-tests", "--showConfig", "--collect-only", "--co", "--fixtures", "--markers", "--no-run", "--list", "-list", "--listFilesOnly", "--just-print", "--recon", "--question"]);

const PREFIX_VALUE_FLAGS = new Set(["-u", "-n", "-s", "-k", "-C", "-g", "-D", "--chdir", "--signal", "--kill-after"]);
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

/** The value of `--flag value` or `--flag=value` among argv[from..], before any `--`. */
function flagValue(argv: readonly string[], from: number, flags: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = from; i < argv.length && argv[i] !== "--"; i++) {
    const arg = argv[i]!;
    if (flags.includes(arg)) value = argv[++i];
    else for (const flag of flags) if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  }
  return value;
}

/** A shell to run, as in `bash -c '...'`, and whether it starts with pipefail or errexit set. */
interface Inline {
  command: string;
  pipefail: boolean;
  errexit: boolean;
}

/** What one simple command runs. `settled: false` when it may run nothing or somewhere unknown. */
interface Program {
  kind: CommandKind;
  settled: boolean;
  cwd: string | null;
  inline: Inline | null;
}
const program = (kind: CommandKind, more: Partial<Program> = {}): Program => ({ kind, settled: true, cwd: null, inline: null, ...more });

/** What one simple command runs, after env assignments, prefixes such as `timeout 60` and runner wrappers such as npx. */
function programShape(argv: readonly string[], start = 0): Program {
  let i = start;
  let negated = false;
  let cwd: string | null = null;
  for (let word = argv[i]; word !== undefined && (ASSIGNMENT.test(word) || PREFIXES.has(word)); word = argv[i]) {
    i = ASSIGNMENT.test(word) ? i + 1 : skipFlags(argv, i + 1, PREFIX_VALUE_FLAGS);
    if (word === "env") cwd = flagValue(argv.slice(0, i), 1, ["-C", "--chdir"]) ?? cwd;
    if (word === "timeout") i++; // its duration
    if (word === "!") negated = true;
  }
  const shape = programAt(argv, i);
  const runs = shape.kind !== "other" || shape.inline !== null;
  if (runs && argv.slice(i).some((arg) => NO_RUN_FLAGS.has(arg.replace(/=.*/, "")))) return program("other");
  return { ...shape, settled: shape.settled && !negated, cwd: joinDir(cwd, shape.cwd) };
}

function programAt(argv: readonly string[], i: number): Program {
  const name0 = argv[i];
  if (name0 === undefined) return program("other");
  const rest = i + 1;
  const name = /^python[\d.]*$/.test(basename(name0)) ? "python" : basename(name0);

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
      return argv[rest] === "run" ? programShape(argv, skipFlags(argv, rest + 1, RUNNER_VALUE_FLAGS)) : program("other");
    case "bundle":
      return argv[rest] === "exec" ? programShape(argv, rest + 1) : program("other");
    case "python": {
      const at = skipFlags(argv, rest, PYTHON_VALUE_FLAGS);
      const flags = argv.slice(rest, at);
      if (flags.at(-1) === "-m") return programShape(argv, at);
      return program(flags.includes("-c") ? "other" : scriptFileKind(argv[at]));
    }
    case "node":
    case "tsx":
    case "ts-node": {
      const at = skipFlags(argv, rest, NODE_VALUE_FLAGS);
      const flags = argv.slice(rest, at);
      if (flags.some((flag) => flag === "--test" || flag.startsWith("--test="))) return program("test");
      return program(flags.some((flag) => ["-e", "--eval", "-p", "--print"].includes(flag)) ? "other" : scriptFileKind(argv[at]));
    }
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
      return shellProgram(argv, rest);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageManagerShape(name, argv, rest);
    case "make": {
      const at = skipFlags(argv, rest, MAKE_VALUE_FLAGS);
      if (argv.slice(rest, at).some((flag) => /^-[a-zA-Z]*[nqt]/.test(flag) && !flag.startsWith("--"))) return program("other");
      const target = argv[at];
      const cwd = flagValue(argv.slice(0, at), rest, ["-C", "--directory"]) ?? null;
      if (target === "test") return program("test", { cwd });
      return program(target === undefined || target === "build" || target === "all" ? "build" : "other", { cwd });
    }
    case "vitest":
      return program(argv[skipFlags(argv, rest)] === "list" ? "other" : "test");
    case "pytest":
    case "py.test":
      return program(argv.slice(rest).includes("-h") ? "other" : "test");
    case "tsc":
      return program(argv.slice(rest).some((arg) => arg === "-h" || arg === "-v") ? "other" : "build");
    case "prettier":
      return program(argv.slice(rest).some((arg) => arg === "--check" || arg === "-c") ? "lint" : "other");
    case "go": {
      const at = skipFlags(argv, rest, new Set(["-C"]));
      const sub = argv[at] === undefined ? undefined : SUBCOMMANDS.go![argv[at]!];
      return program(sub ?? "other", { cwd: flagValue(argv.slice(0, at), rest, ["-C"]) ?? null });
    }
  }
  const bin = BINS[name];
  if (bin) return program(bin);
  const sub = argv[skipFlags(argv, rest)];
  const subcommand = sub === undefined ? undefined : SUBCOMMANDS[name]?.[sub];
  if (subcommand) {
    const manifest = name === "cargo" ? flagValue(argv, rest, ["--manifest-path"]) : undefined;
    return program(subcommand, { cwd: manifest === undefined ? null : dirname(manifest) });
  }
  return program(name0.includes("/") ? scriptFileKind(name0) : "other");
}

/** `bash -c '...'` runs its argument as a line of its own; `bash -eo pipefail -c` starts it with those set. */
function shellProgram(argv: readonly string[], from: number): Program {
  let inline = false;
  let pipefail = false;
  let errexit = false;
  let i = from;
  for (; i < argv.length && /^[-+]/.test(argv[i]!) && argv[i] !== "-" && argv[i] !== "--"; i++) {
    const flag = argv[i]!;
    if (flag.startsWith("--")) continue;
    const on = flag[0] === "-";
    if (flag.includes("c") && on) inline = true;
    if (flag.includes("e")) errexit = on;
    if (flag.includes("o")) {
      const option = argv[++i];
      if (option === "pipefail") pipefail = on;
      if (option === "errexit") errexit = on;
    }
  }
  if (inline) return argv[i] === undefined ? program("other") : program("other", { inline: { command: argv[i]!, pipefail, errexit } });
  return program(scriptFileKind(argv[i]));
}

function packageManagerShape(name: string, argv: readonly string[], from: number): Program {
  // A workspace selector picks packages this reader cannot place: the run is not this directory's.
  const selected = argv.slice(from).some((arg) => /^(?:-w|-F|-r|-ws|--filter|--workspaces?|--recursive)(?:=|$)/.test(arg)) || (name === "yarn" && argv[skipFlags(argv, from, PM_VALUE_FLAGS)] === "workspace");
  const cwd = flagValue(argv, from, ["-C", "--dir", "--prefix", "--cwd"]) ?? null;
  const settle = (shape: Program): Program => ({ ...shape, settled: shape.settled && !selected && !argv.includes("--if-present"), cwd: joinDir(cwd, shape.cwd) });

  let i = skipFlags(argv, from, PM_VALUE_FLAGS);
  if (name === "yarn" && argv[i] === "workspace") i = skipFlags(argv, i + 2, PM_VALUE_FLAGS);
  const sub = argv[i];
  if (sub === undefined) return program("other");
  if (sub === "run" || sub === "run-script") return settle(program(scriptKind(argv[skipFlags(argv, i + 1, PM_VALUE_FLAGS)]) ?? "other"));
  if (sub === "exec" || sub === "x" || sub === "dlx") return settle(programShape(argv, skipFlags(argv, i + 1, RUNNER_VALUE_FLAGS)));
  if (name === "npm") return settle(program(sub === "test" || sub === "t" || sub === "tst" ? "test" : "other"));
  if (name === "bun" && sub === "test") return settle(program("test"));
  if (name === "bun" && /[./]/.test(sub)) return settle(program(scriptFileKind(sub)));
  if (PM_BUILTINS.has(sub)) return program("other");
  // pnpm, yarn and bun run a script or a binary by name: `pnpm test`, `yarn jest`, `pnpm vitest run`.
  const script = scriptKind(sub);
  return settle(script ? program(script) : programShape(argv, i));
}

/** `cd a` then `cd b`: a/b; an absolute directory replaces what came before. */
function joinDir(base: string | null, dir: string | null): string | null {
  if (dir === null || base === null || dir.startsWith("/")) return dir ?? base;
  return `${base}/${dir}`;
}

const programWord = (argv: readonly string[]): number => {
  let i = 0;
  while (i < argv.length && (ASSIGNMENT.test(argv[i]!) || PREFIXES.has(argv[i]!))) i = ASSIGNMENT.test(argv[i]!) ? i + 1 : skipFlags(argv, i + 1, PREFIX_VALUE_FLAGS) + (argv[i] === "timeout" ? 1 : 0);
  return i;
};

/** Commands that set up the shell and cannot be the reason a line failed. */
const SETUP = new Set(["cd", "pushd", "export", "set", "setopt", "unsetopt", "shopt", "unset", "true", ":", "echo", "printf", "umask", "alias", "local", "declare", "typeset", "ulimit"]);
const isSetup = ({ argv }: Segment) => {
  const word = argv[programWord(argv)];
  return word === undefined || SETUP.has(word);
};
/** Pipeline stages after a run that do not fail on their own, so under pipefail the status stays the run's. */
const PASS_THROUGH = new Set(["tail", "head", "tee", "cat", "cut", "sort", "uniq", "wc", "nl", "column", "less", "more", "sed", "ts"]);

/** The shell state a segment leaves: pipefail, errexit and the directory. */
interface ShellState {
  pipefail: boolean;
  errexit: boolean;
  cwd: string | null;
  /** A directory change this reader cannot follow. */
  lost: boolean;
}

function applySetting(state: ShellState, { argv }: Segment): void {
  const word = argv[0];
  if (word === "set") {
    for (let i = 1; i < argv.length; i++) {
      const flag = /^([-+])([a-zA-Z]+)$/.exec(argv[i]!);
      if (!flag) continue;
      const on = flag[1] === "-";
      if (flag[2]!.includes("e")) state.errexit = on;
      if (flag[2]!.includes("o")) {
        const option = argv[++i];
        if (option === "pipefail") state.pipefail = on;
        if (option === "errexit") state.errexit = on;
      }
    }
  } else if (word === "setopt" || word === "unsetopt") {
    for (const arg of argv.slice(1)) {
      const option = arg.toLowerCase().replaceAll("_", "");
      const on = (word === "setopt") !== option.startsWith("no");
      if (option.replace(/^no/, "") === "pipefail") state.pipefail = on;
      if (option.replace(/^no/, "") === "errexit") state.errexit = on;
    }
  } else if (word === "cd" || word === "pushd") {
    const target = argv[skipFlags(argv, 1)];
    if (target === undefined || /^[~$`-]|\$/.test(target)) state.lost = true;
    else state.cwd = joinDir(state.cwd, target);
  } else if (word === "popd") state.lost = true;
}

const subshells = (scope: readonly number[]) => scope.filter((id) => id > 0);
const isPrefix = (prefix: readonly number[], of: readonly number[]) => prefix.length <= of.length && prefix.every((id, i) => of[i] === id);
const common = (a: readonly number[], b: readonly number[]) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
};

type Settle = "own" | "on-success" | "unknown";
const worse = (a: Settle, b: Settle): Settle => (a === "unknown" || b === "unknown" ? "unknown" : a === "on-success" || b === "on-success" ? "on-success" : "own");

/** A final `echo "exit: $?"`: the line it prints is `label`, the status, then `trailer`. */
interface Echo {
  label: string;
  trailer: string;
}

function statusEcho({ argv, outputs }: Segment): Echo | null {
  if (argv[0] !== "echo" || outputs.some(({ fd }) => fd === "1" || fd === "&")) return null;
  let i = 1;
  while (/^-[neE]+$/.test(argv[i] ?? "")) i++;
  const text = argv.slice(i).join(" ");
  const at = text.indexOf("$?");
  if (at < 0 || /[$`\\]/.test(text.slice(0, at) + text.slice(at + 2))) return null;
  return { label: text.slice(0, at), trailer: text.slice(at + 2) };
}

/** A run as the line leaves it, before the call's output and exit code are read. */
interface Draft {
  kind: CommandKind;
  settle: Settle;
  echo: Echo | null;
  cwd: string | null;
}

interface Analysis {
  runs: Draft[];
  writes: boolean;
}

function analyze(command: string, initial: { pipefail: boolean; errexit: boolean }): Analysis {
  const segments = shellSegments(command);
  const programs = segments.map(({ argv }) => programShape(argv));
  const control = segments.some(({ argv }) => CONTROL.has(argv[0]!)) || FUNCTION_DEFINITION.test(command);

  /** The shell state segment `index` runs in, from the settings before it in its own shell. */
  /** An earlier `||` can skip segment `k`; an earlier `&&` runs it only on success. "own" when it always runs. */
  const guards: Settle[] = [];
  const pending: { settle: Settle; scope: readonly number[] }[] = [];
  segments.forEach((segment, i) => {
    guards.push(pending.reduce<Settle>((settle, p) => worse(settle, p.settle), "own"));
    const { next } = segment;
    if (next === null || i + 1 === segments.length) return;
    const at = common(segment.scope, segments[i + 1]!.scope);
    // A separator ends the conditionals at its level and inside it, not those around a group it is in.
    if (next === ";" || next === "&") for (let p = pending.length - 1; p >= 0; p--) if (isPrefix(at, pending[p]!.scope)) pending.splice(p, 1);
    if (next === "||") pending.push({ settle: "unknown", scope: at });
    if (next === "&&" && !isSetup(segment)) pending.push({ settle: "on-success", scope: at });
  });

  const stage = (i: number) => segments[i]!.next === "|" || segments[i - 1]?.next === "|";
  /** The first and last segment of each `{ }` group. */
  const braces = new Map<number, { first: number; last: number }>();
  segments.forEach(({ scope }, i) => {
    for (const id of scope) if (id < 0) braces.set(id, { first: braces.get(id)?.first ?? i, last: i });
  });
  /** Segment `j` is a pipeline stage, or inside a `{ }` group that is, apart from groups that also hold `k`: a child shell. */
  const piped = (j: number, k: number): boolean =>
    stage(j) || segments[j]!.scope.some((id) => id < 0 && !segments[k]?.scope.includes(id) && (stage(braces.get(id)!.first) || stage(braces.get(id)!.last)));

  /**
   * The shell state segment `index` runs in, from the settings before it in its own shell. A setting that may not have
   * run (after && or ||) or that ran in a pipeline's child shell counts the cautious way: pipefail off, errexit on, the
   * directory lost.
   */
  const states = new Map<string, ShellState>();
  const stateAt = (index: number, scope: readonly number[]): ShellState => {
    const key = `${index}:${scope.join(",")}`;
    const known = states.get(key);
    if (known) return known;
    const state: ShellState = { ...initial, cwd: null, lost: false };
    for (let j = 0; j < index; j++) {
      if (!isPrefix(subshells(segments[j]!.scope), subshells(scope))) continue;
      if (guards[j] === "own" && !piped(j, index)) {
        applySetting(state, segments[j]!);
        continue;
      }
      const maybe = { ...state };
      applySetting(maybe, segments[j]!);
      state.pipefail &&= maybe.pipefail;
      state.errexit ||= maybe.errexit;
      state.lost ||= maybe.lost || maybe.cwd !== state.cwd;
    }
    states.set(key, state);
    return state;
  };

  /** Whether the run at `k` ran: an earlier `||` can skip it, an earlier `&&` or errexit settles it only on success. */
  const before = (k: number): Settle => {
    let settle = guards[k]!;
    if (!initial.errexit && !segments.some(({ argv }) => argv[0] === "set" || argv[0] === "setopt")) return settle;
    for (let i = 0; i < k; i++) {
      if (segments[i]!.next === ";" && !isSetup(segments[i]!) && stateAt(i, segments[k]!.scope).errexit) settle = worse(settle, "on-success");
    }
    return settle;
  };

  /** Whether the run at `k`'s status reaches the end of the line, or a final echo prints it. */
  const after = (k: number): { settle: Settle; echo: Echo | null } => {
    let settle: Settle = "own";
    for (let i = k; ; i++) {
      const { next } = segments[i]!;
      const following = segments[i + 1];
      if (next === "||" || next === "&") return { settle: "unknown", echo: null };
      if (next === null || following === undefined) return { settle, echo: null };
      if (next === "|") {
        // The shell that runs this pipe: a `{ }` group piped onward is a child, so its settings do not reach here.
        if (!stateAt(i + 1, common(subshells(segments[i]!.scope), subshells(following.scope))).pipefail) return { settle: "unknown", echo: null };
        if (!PASS_THROUGH.has(following.argv[programWord(following.argv)] ?? "")) settle = worse(settle, "on-success");
      } else if (next === "&&") {
        if (!isSetup(following)) settle = worse(settle, "on-success");
      } else {
        const echo = i + 1 === segments.length - 1 ? statusEcho(following) : null;
        return echo ? { settle, echo } : { settle: "unknown", echo: null };
      }
    }
  };

  const runs: Draft[] = [];
  segments.forEach((segment, k) => {
    const shape = programs[k]!;
    if (shape.kind === "other" && shape.inline === null) return;
    const state = stateAt(k, segment.scope);
    const { settle: afterSettle, echo } = after(k);
    let settle = worse(before(k), afterSettle);
    if (control || state.lost || !shape.settled) settle = "unknown";
    const cwd = joinDir(state.cwd, shape.cwd);
    if (shape.inline === null) {
      runs.push({ kind: shape.kind, settle, echo, cwd });
      return;
    }
    for (const inner of analyze(shape.inline.command, shape.inline).runs) {
      // An echo inside the wrapper speaks for its run only when nothing outside prints or decides after it.
      const innerSettle = inner.echo && echo ? "unknown" : worse(settle, inner.settle);
      runs.push({ kind: inner.kind, settle: innerSettle, echo: inner.echo ?? echo, cwd: joinDir(cwd, inner.cwd) });
    }
  });
  return { runs, writes: segments.some((segment, k) => writes(segment, programs[k]!)) };
}

/** Programs that only read, at least without the flags `writes` checks for. */
const READS = new Set(["fi", "done", "esac", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "tree", "pwd", "cd", "pushd", "popd", "echo", "printf", "true", "false", ":", "test", "[", "[[", "which", "type", "file", "stat", "du", "df", "diff", "cmp", "sort", "cut", "tr", "jq", "sed", "nl", "column", "less", "more", "printenv", "date", "sleep", "wait", "set", "export", "unset", "setopt", "unsetopt", "shopt", "readlink", "realpath", "dirname", "basename", "uname", "whoami", "id", "hostname", "ps", "exit", "return", "local", "declare", "typeset", "alias", "env", "tee", "xxd", "od", "md5", "md5sum", "shasum", "sha256sum"]);
/** git subcommands that change the working tree. */
const GIT_WRITES = new Set(["checkout", "switch", "restore", "reset", "apply", "am", "stash", "merge", "rebase", "pull", "cherry-pick", "revert", "clean", "mv", "rm", "submodule", "read-tree", "checkout-index", "worktree"]);
const PM_READS = new Set(["ls", "list", "why", "outdated", "view", "info", "show", "help", "explain", "root", "bin", "whoami", "search", "audit"]);
const isFile = (target: string) => !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(target);

/** Whether a segment may change files, other than by being a test, build or lint run. */
function writes(segment: Segment, shape: Program): boolean {
  const { argv } = segment;
  if (segment.outputs.some(({ target }) => isFile(target))) return true;
  if (argv.some((arg) => arg.includes("$(") || arg.includes("`"))) return true;
  if (shape.inline) return analyze(shape.inline.command, shape.inline).writes;
  const at = programWord(argv);
  const name = argv[at];
  if (name === undefined) return false;
  const args = argv.slice(at + 1);
  if (shape.kind === "lint") return args.some((arg) => /^--(?:fix|write|apply)/.test(arg));
  if (shape.kind !== "other") return false;
  if (args.some((arg) => NO_RUN_FLAGS.has(arg.replace(/=.*/, "")))) return false;
  switch (basename(name)) {
    case "sed":
      return args.some((arg) => /^-[a-zA-Z]*i|^--in-place/.test(arg));
    case "find":
      return args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(arg));
    case "sort":
      return args.some((arg) => /^-[a-zA-Z]*o|^--output/.test(arg));
    case "tee":
      return args.some((arg) => !arg.startsWith("-") && isFile(arg));
    case "git": {
      const sub = argv[skipFlags(argv, at + 1, new Set(["-C", "-c", "--git-dir", "--work-tree"]))];
      return sub === undefined ? false : GIT_WRITES.has(sub) && !(sub === "stash" && /^(?:list|show)$/.test(argv[argv.indexOf(sub) + 1] ?? "")) && !(sub === "worktree" && argv[argv.indexOf(sub) + 1] === "list");
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const sub = argv[skipFlags(argv, at + 1, PM_VALUE_FLAGS)];
      return !(sub !== undefined && PM_READS.has(sub) && !args.includes("fix"));
    }
  }
  return !READS.has(basename(name));
}

function finish(draft: Draft, output: string | undefined, reported: number | null): CommandRun {
  const unknown: CommandRun = { kind: draft.kind, status: "unknown", exitCode: null, cwd: draft.cwd };
  const own = (exitCode: number | null): CommandRun => ({ ...unknown, status: "own", exitCode });
  if (draft.settle === "unknown") return unknown;
  if (draft.echo) {
    // The call's own status is the echo's: anything but success means the echo is not what ended the line.
    if (reported !== null && reported !== 0) return unknown;
    const code = echoedStatus(draft.echo, output);
    if (code === null) return unknown;
    return draft.settle === "own" || code === 0 ? own(code) : unknown;
  }
  if (draft.settle === "own") return own(reported);
  return reported === 0 ? own(0) : unknown;
}

/** The status on the output's last line, which the final echo printed; null unless that line is exactly the echo's. */
function echoedStatus({ label, trailer }: Echo, output: string | undefined): number | null {
  const last = output?.trimEnd().split("\n").at(-1)?.trim();
  if (!last) return null;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escape(label.trimStart())}(\\d{1,3})${escape(trailer.trimEnd())}$`).exec(last);
  const code = match ? Number(match[1]) : null;
  return code !== null && code <= 255 ? code : null;
}

/**
 * What a command line ran and what its exit status says about each run. `output` is what the call printed and
 * `reportedExitCode` the call's own exit code (0 for a call the provider reports as completed), null when unknown.
 * A status echoed with `$?` is read only from the output's last line; when it cannot be read, the run is unknown.
 */
export function commandResult(command: string, output: string | undefined, reportedExitCode: number | null): CommandResult {
  const { runs: drafts, writes } = analyze(command, { pipefail: false, errexit: false });
  const runs = drafts.map((draft) => finish(draft, output, reportedExitCode));
  const main = runs.reduce<CommandRun | null>((best, run) => (!best || RANK[run.kind] >= RANK[best.kind] ? run : best), null);
  return { ...(main ?? { kind: "other", status: "own", exitCode: reportedExitCode, cwd: null }), runs, writes };
}

/** By the program each segment runs, never by a word anywhere in the line; unknown when the status needs the call's output or a directory it cannot check. */
export function commandShape(command: string): CommandShape {
  const { kind, status, cwd } = commandResult(command, undefined, null);
  return { kind, status: cwd === null ? status : "unknown" };
}

export const commandKind = (command: string): CommandKind => commandShape(command).kind;
