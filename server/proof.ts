import { isAbsolute, relative, resolve } from "node:path";
import { PROOF_RULES, type ClaimKind, type ClaimVerdict, type Outcome, type ProofCommand, type ProofReport, type Verdict } from "../shared/report";
import { commandKind, commandResult, isTestFile, type CommandResult } from "../shared/command-kind";
import { shellSegments } from "../shared/shell";
import type { AgentTimelineItem } from "./host-types";

type ToolCall = Extract<AgentTimelineItem, { type: "tool_call" }>;

const MAX_COMMANDS = 12;
const MAX_FILES = 20;

/**
 * Timeline items carry no timestamp or turn id (`getItems` strips the row, agent-timeline-store.ts:60-64),
 * so the turn is cut by position: from the first user message after the previous turn's end (or the end itself
 * for an autonomous turn, which a finished background task starts without one), or from the last user message
 * when the previous end is unknown (first turn seen, plugin restart, shrunken timeline).
 */
export function sliceTurn(timeline: readonly AgentTimelineItem[], previousEnd: number | null): AgentTimelineItem[] {
  const from = previousEnd !== null && previousEnd <= timeline.length ? previousEnd : null;
  if (from !== null) {
    const firstUser = timeline.findIndex((item, i) => i >= from && item?.type === "user_message");
    return timeline.slice(firstUser >= 0 ? firstUser : from);
  }
  let lastUser = -1;
  timeline.forEach((item, i) => {
    if (item?.type === "user_message") lastUser = i;
  });
  return lastUser >= 0 ? timeline.slice(lastUser) : timeline.slice();
}

export { commandKind, isTestFile };

/**
 * Claude Code puts no exit code in the timeline: a non-zero Bash exit arrives as `is_error` (status "failed",
 * claude/agent.ts:5580-5592) whose error content starts with "Exit code N". Codex sets `detail.exitCode`
 * (codex/tool-call-mapper.ts:689-694). OpenCode keeps its raw tool metadata on the item (opencode/tool-call-mapper.ts:56,66).
 */
function ownExitCodeOf(call: ToolCall): number | null {
  if (call.detail.type === "shell" && typeof call.detail.exitCode === "number") return call.detail.exitCode;
  const meta = call.metadata as { exit?: unknown; exitCode?: unknown } | undefined;
  if (typeof meta?.exit === "number") return meta.exit;
  if (typeof meta?.exitCode === "number") return meta.exitCode;
  if (call.status === "failed") {
    const text = errorText(call.error);
    const match = /\bExit code (\d+)\b/i.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { content, message } = error as { content?: unknown; message?: unknown };
    if (typeof content === "string") return content;
    if (typeof message === "string") return message;
  }
  return "";
}

const DENIAL_RE = /^(?:(?:Denied by user|Permission(?: request)? denied)$|Permission to use .+ has been denied|The user (?:rejected permission|answered with a message instead of approving))/;
const deniedFlag = (call: ToolCall) => (call.metadata as { denied?: unknown } | undefined)?.denied === true;

/**
 * At Paseo v0.11.4, Codex carries Paseo's own `metadata.denied` (codex-app-server-agent.ts:4875-4909); Claude Code
 * and OpenCode leave only the deny message as the error (claude/agent.ts:5420-5429). A custom deny message reads as a failure.
 */
function isDenied(call: ToolCall): boolean {
  if (call.status !== "failed") return false;
  return deniedFlag(call) || (ownExitCodeOf(call) === null && DENIAL_RE.test(errorText(call.error).trim()));
}

/** Codex also reports the refused item itself, declined and mapped to a plain failure. */
function codexDeclinedTwin(turn: readonly AgentTimelineItem[]): (call: ToolCall) => boolean {
  const ids = new Set<string>();
  const commands = new Set<string>();
  for (const item of turn) {
    if (item.type !== "tool_call" || !deniedFlag(item)) continue;
    ids.add(item.callId.replace(/^permission-/, ""));
    if (item.detail.type === "shell") commands.add(item.detail.command);
  }
  return (call) =>
    call.status === "failed" && !deniedFlag(call) && ownExitCodeOf(call) === null && (ids.has(call.callId) || (call.detail.type === "shell" && commands.has(call.detail.command)));
}

function outcomeOf(call: ToolCall, exitCode: number | null): Outcome {
  if (isDenied(call)) return "denied";
  if (call.status === "running" || call.status === "canceled") return call.status;
  return call.status === "failed" || (exitCode !== null && exitCode !== 0) ? "failed" : "ok";
}

/** Where commands ran: the repository root and the agent's cwd (and its real path, when the cwd is a symlinked alias). */
export interface RunContext {
  root: string;
  cwd: string;
  realCwd?: string;
  cwdUnconfirmed?: boolean;
}

/** Is `dir` (absolute, or relative to `base`) inside the repository? With no context, only a relative path that stays below the cwd is. */
function insideRepo(dir: string, base: string | null, context: RunContext | undefined): boolean {
  if (!context) return !isAbsolute(dir) && !dir.split("/").includes("..");
  const realCwd = context.realCwd ?? context.cwd;
  const from = base === null ? realCwd : isAbsolute(base) ? base : resolve(realCwd, base);
  const abs = resolve(from, dir);
  const aliased = abs === context.cwd || abs.startsWith(`${context.cwd}/`) ? realCwd + abs.slice(context.cwd.length) : abs;
  return [abs, aliased].some((path) => {
    const inRepo = relative(context.root, path);
    return inRepo === "" || (inRepo !== ".." && !inRepo.startsWith("../") && !isAbsolute(inRepo));
  });
}

/**
 * One entry per test, build or lint run on the line (`npm run build && npm test` is a build and a test), or one for the
 * line when it runs none. `call` is the line's own outcome; a run settles only when the line returns its status, and
 * only inside this repository.
 */
function runsOf(command: string, index: number, result: CommandResult, call: { outcome: Outcome; exitCode: number | null }, callCwd: string | null, context: RunContext | undefined): ProofCommand[] {
  const runs = result.runs.filter((run) => run.kind !== "other");
  if (runs.length === 0) return [{ command, kind: result.kind, index, exitCode: call.exitCode, outcome: call.outcome }];
  const callElsewhere = callCwd !== null && context !== undefined && !insideRepo(callCwd, null, context);
  return runs.map((run): ProofCommand => {
    const entry = { command, kind: run.kind, index };
    if (call.outcome !== "ok" && call.outcome !== "failed") return { ...entry, exitCode: null, outcome: call.outcome };
    if (callElsewhere || (run.cwd !== null && !insideRepo(run.cwd, callCwd, context))) return { ...entry, exitCode: null, outcome: "elsewhere" };
    if (run.status !== "own") return { ...entry, exitCode: null, outcome: "unknown" };
    if (run.exitCode === null) return { ...entry, exitCode: null, outcome: call.outcome };
    return { ...entry, exitCode: run.exitCode, outcome: run.exitCode === 0 ? "ok" : "failed" };
  });
}

/**
 * Claude Code answers a Bash call it moved to the background at once, completed and with no exit code
 * (Bash tool result text in Claude Code 2.x). The command's own end comes later, if at all.
 */
const BACKGROUND_RE = /^(?:Command running in background with ID: |Command was manually backgrounded by user with ID: |Command did not complete within its \d+s timeout and was moved to the background \(ID: )([\w-]+)/m;

function backgroundTaskId(call: ToolCall): string | null {
  if (call.detail.type !== "shell" || call.status !== "completed" || ownExitCodeOf(call) !== null) return null;
  return BACKGROUND_RE.exec(call.detail.output ?? "")?.[1] ?? null;
}

const FINAL_STATUS: Readonly<Record<string, Outcome>> = { completed: "ok", failed: "failed", error: "failed", killed: "canceled", stopped: "canceled", canceled: "canceled", cancelled: "canceled" };

function reportText(call: ToolCall): string {
  const d = call.detail as { text?: unknown; output?: unknown };
  const output = d.output && typeof d.output === "object" ? (d.output as { output?: unknown }).output : d.output;
  return [d.text, output, errorText(call.error)].filter((part): part is string => typeof part === "string").join("\n");
}

/**
 * A later call in the same turn that reports the background task's end: Paseo's task_notification item
 * (claude/task-notification-tool-call.ts, raw status in metadata, "exit code N" in the summary) or a TaskOutput result
 * (`<status>` and `<exit_code>` tags). The last final report wins.
 */
function backgroundEnd(turn: readonly AgentTimelineItem[], index: number, call: ToolCall, taskId: string): { exitCode: number | null; outcome: Outcome; reportIndex: number } | null {
  for (let i = turn.length - 1; i > index; i--) {
    const item = turn[i]!;
    if (item.type !== "tool_call" || item.detail.type === "shell") continue;
    const meta = item.metadata as { toolUseId?: unknown; taskId?: unknown; status?: unknown } | undefined;
    const text = reportText(item);
    const about = meta?.toolUseId === call.callId || meta?.taskId === taskId || [`<task-id>${taskId}</task-id>`, `<task_id>${taskId}</task_id>`].some((tag) => text.includes(tag));
    if (!about) continue;
    const status = (typeof meta?.status === "string" ? meta.status : /<status>(\w+)<\/status>/.exec(text)?.[1])?.toLowerCase();
    const final = status === undefined ? undefined : FINAL_STATUS[status];
    if (!final) continue;
    const code = /<exit_code>(-?\d+)<\/exit_code>|\(exit code (-?\d+)\)|with exit code (-?\d+)/.exec(text);
    const exitCode = code ? Number(code[1] ?? code[2] ?? code[3]) : null;
    const outcome = final === "canceled" || exitCode === null ? final : exitCode === 0 ? "ok" : "failed";
    return { exitCode, outcome, reportIndex: i };
  }
  return null;
}

/** Paths a tool call wrote. Codex multi-file patches that fail edit-detail parsing keep `input.files` (codex/tool-call-mapper.ts:848-856, 98-107). */
function writtenPaths(call: ToolCall): string[] {
  const d = call.detail;
  if (d.type === "write" || d.type === "edit") return [d.filePath];
  if (d.type === "unknown" && d.input && typeof d.input === "object") {
    const files = (d.input as { files?: unknown }).files;
    if (Array.isArray(files)) return files.flatMap((f) => (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" ? [(f as { path: string }).path] : []));
  }
  return [];
}

export interface TurnEvidence {
  commands: ProofCommand[];
  commandsTotal: number;
  failedTools: { name: string; summary: string }[];
  deniedTools: { name: string; summary: string }[];
  files: string[];
  lastEditIndex: number | null;
  finalMessage: string | null;
  /** Already-matched claims, when rebuilding from a stored report that no longer has the message. */
  claims?: Claim[];
}

const isText = (value: unknown) => value === undefined || value === null || typeof value === "string";

const changesCwd = (command: string) => shellSegments(command).some((segment) => !segment.scope.some((id) => id > 0) && ["cd", "pushd", "popd"].includes(segment.argv[0] ?? ""));

/** Directory state carried between provider calls, including earlier turns still present in the host timeline. */
export function unreportedCwdAfter(timeline: readonly AgentTimelineItem[]): boolean {
  let uncertain = false;
  for (const item of timeline) {
    if (!wellFormed(item) || item.type !== "tool_call" || item.detail.type !== "shell" || isDenied(item)) continue;
    if (item.status === "completed" && typeof item.detail.cwd === "string" && item.detail.cwd !== "") uncertain = false;
    if (changesCwd(item.detail.command)) uncertain = true;
  }
  return uncertain;
}

/** The shape this file reads. The timeline comes from provider mappers; one odd item must not cost the turn its card. */
function wellFormed(item: unknown): item is AgentTimelineItem {
  if (!item || typeof item !== "object" || typeof (item as { type?: unknown }).type !== "string") return false;
  const { type, detail } = item as { type: string; detail?: unknown };
  if (type === "assistant_message" || type === "user_message") return typeof (item as { text?: unknown }).text === "string";
  if (type !== "tool_call") return true;
  if (!detail || typeof detail !== "object" || typeof (detail as { type?: unknown }).type !== "string") return false;
  const d = detail as { type: string; command?: unknown; output?: unknown; filePath?: unknown };
  if (d.type === "shell") return typeof d.command === "string" && isText(d.output);
  if (d.type === "write" || d.type === "edit" || d.type === "read") return typeof d.filePath === "string";
  return true;
}

/**
 * `context` is where the agent works: a run outside it settles nothing for this repository. Without it (unit tests),
 * only a `cd` to an absolute path or above the cwd counts as elsewhere.
 */
export function extractEvidence(timeline: readonly AgentTimelineItem[], context?: RunContext): TurnEvidence {
  const turn = timeline.filter(wellFormed);
  const commands: ProofCommand[] = [];
  const failedTools: TurnEvidence["failedTools"] = [];
  const deniedTools: TurnEvidence["deniedTools"] = [];
  const files = new Set<string>();
  let lastEditIndex: number | null = null;
  let finalMessage: string | null = null;
  // Some providers persist Bash's directory but omit it from later timeline calls.
  let cwdMayHaveChanged = context?.cwdUnconfirmed ?? false;
  const isTwin = codexDeclinedTwin(turn);
  const backgroundReports = new Set<number>();
  turn.forEach((item, index) => {
    if (item.type === "assistant_message") finalMessage = item.text;
    if (item.type !== "tool_call" || isTwin(item) || backgroundReports.has(index)) return;
    if (item.detail.type === "shell") {
      const { command } = item.detail;
      const taskId = backgroundTaskId(item);
      const end = taskId === null ? null : backgroundEnd(turn, index, item, taskId);
      if (end) backgroundReports.add(end.reportIndex);
      const own = ownExitCodeOf(item);
      const exitCode = taskId === null ? own : (end?.exitCode ?? null);
      const outcome = taskId === null ? outcomeOf(item, exitCode) : (end?.outcome ?? "background");
      // A completed foreground call with no exit code (Claude Code) exited 0. The output is the line's only in the foreground.
      const reported = exitCode ?? (taskId === null && outcome === "ok" ? 0 : null);
      const result = commandResult(command, taskId === null ? (item.detail.output ?? undefined) : undefined, reported);
      const callCwd = typeof item.detail.cwd === "string" && item.detail.cwd !== "" ? item.detail.cwd : null;
      if (callCwd !== null && outcome === "ok") cwdMayHaveChanged = false;
      const runs = runsOf(command, index, result, { outcome, exitCode }, callCwd, context);
      commands.push(...runs.map((run): ProofCommand => callCwd === null && cwdMayHaveChanged && run.kind !== "other" && (run.outcome === "ok" || run.outcome === "failed") ? { ...run, exitCode: null, outcome: "cwd_unknown" } : run));
      if (outcome !== "denied" && changesCwd(command)) cwdMayHaveChanged = true;
      // `sed -i`, `cat > f <<EOF`, `git checkout -- src`: a shell write ends the scope like an Edit does. A denied one did not run.
      if (result.writes && outcome !== "denied") lastEditIndex = index;
    } else if (item.status === "failed" && isDenied(item)) {
      const d = item.detail;
      deniedTools.push({ name: item.name, summary: d.type === "write" || d.type === "edit" || d.type === "read" ? d.filePath : "" });
    } else if (item.status === "failed") {
      failedTools.push({ name: item.name, summary: errorText(item.error).split("\n")[0]!.slice(0, 160) });
    }
    const written = item.status === "failed" ? [] : writtenPaths(item);
    if (written.length > 0) lastEditIndex = index;
    for (const p of written) files.add(p);
  });
  return { commands, commandsTotal: new Set(commands.map((c) => c.index)).size, failedTools, deniedTools, files: [...files], lastEditIndex, finalMessage };
}

/**
 * Timeline paths are absolute (Claude Code) or relative to the agent's cwd (Codex), and that cwd may be a symlinked alias
 * (macOS /tmp); git's are relative to the repo root.
 */
export function toRepoPath(path: string, dirs: { root: string; cwd: string; realCwd: string }): string {
  const aliased = isAbsolute(path) && path.startsWith(`${dirs.cwd}/`);
  const abs = aliased ? dirs.realCwd + path.slice(dirs.cwd.length) : resolve(dirs.realCwd, path);
  const inRepo = relative(dirs.root, abs);
  return inRepo && inRepo !== ".." && !inRepo.startsWith("../") && !isAbsolute(inRepo) ? inRepo : abs;
}

export interface Claim {
  kind: ClaimKind;
  text: string;
}

const CLAIM_PATTERNS: { kind: ClaimKind; re: RegExp }[] = [
  {
    kind: "tests_pass",
    re: /\b(all (?:the )?(?:\d+ )?tests? (?:are )?(?:now )?(?:pass(?:es|ed|ing)?|green|succeed)|tests? (?:now )?(?:pass(?:es|ed|ing)?|(?:are|is) (?:now )?(?:all )?(?:passing|green))|tests?: ok|(?:test )?suite (?:now )?(?:pass(?:es|ed)?|is (?:now )?(?:passing|green))|\d+ (?:tests? )?passed)\b/i,
  },
  { kind: "build_ok", re: /\b(build (?:now )?(?:succeeds|passes|is green|is clean)|build: ok|builds? (?:cleanly|successfully)|(?:compiles|type-?checks?) (?:cleanly|without errors|successfully)|type-?check (?:now )?pass(?:es|ed)|no type errors)\b/i },
  { kind: "verified", re: /\b(verified|confirmed (?:it|that|the fix)|i (?:ran|tested) (?:it|the|them))\b/i },
  { kind: "fixed", re: /\b(fixed|is now resolved|resolved the)\b/i },
  { kind: "done", re: /^(?:done|all done|complete)\b|\b(task is (?:done|complete)|everything is (?:done|working)|all set)\b/i },
];
/** "`npm test` passes": the claim's kind is the quoted command's. */
const CODE_PASSES_RE = /`([^`]+)`\s+(?:now\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|is (?:now )?(?:passing|green|clean))\b/gi;
const CODE_CLAIMS: Partial<Record<ReturnType<typeof commandKind>, ClaimKind>> = { test: "tests_pass", build: "build_ok" };
// A sentence that hedges, negates, plans, or names a failure is not a claim. English only.
const SKIP_RE = /\b(not|no|none|\w+n['’]t|no longer|never|fail(?:s|ed|ing|ures?)?|errors?|errored|crash(?:es|ed)?|broken?|broke|unable|cannot|could not|if|once|should|would|will|may|might|please|try|let me|i['’]ll|todo|to be)\b|\?$/i;
// A zero count of failures or errors ("2 passed, 0 failed", "fail 0", "no type errors") is part of a passing summary, not a negation.
// The zero stands alone: "20.0 failed" or "10 failed" is no zero count.
const ZERO = String.raw`(?<!\w|\d[.,])(?:0|zero|no)(?!\w|[.,]\d)`;
const BAD = String.raw`(?:fail(?:s|ed|ing|ures?)?|errors?)`;
const ZERO_COUNT_RE = new RegExp(String.raw`${ZERO}\s+(?:(?:tests?|type|lint|build|compile)\s+)?${BAD}\b|\b${BAD}:?\s+0(?!\w|[.,]\d)`, "gi");
/** Text in double quotes is someone else's words: a task title, an issue, what the agent will not say. */
const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”/g;

/** Conservative: at most one claim per kind, from sentences without negation or hedging. */
export function matchClaims(message: string | null): Claim[] {
  if (!message) return [];
  const found = new Map<ClaimKind, Claim>();
  const sentences = message
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:[>*#-]+|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const own = sentence.replace(QUOTED_RE, " ");
    if (SKIP_RE.test(own.replace(ZERO_COUNT_RE, ""))) continue;
    const add = (kind: ClaimKind) => found.has(kind) || found.set(kind, { kind, text: sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence });
    for (const [, code] of own.matchAll(CODE_PASSES_RE)) {
      const kind = CODE_CLAIMS[commandKind(code!)];
      if (kind) add(kind);
    }
    const prose = own.replace(/`[^`]*`/g, " code ");
    for (const { kind, re } of CLAIM_PATTERNS) if (re.test(prose)) add(kind);
  }
  return [...found.values()];
}

export interface PluginCheck {
  command: string;
  passed: boolean;
}

interface ClaimRule {
  kinds: readonly ProofCommand["kind"][];
  /** What the accepted kinds run, for "check not counted, npm run lint runs no tests". */
  runs: string;
  unproven: Extract<Verdict, "unsupported" | "unchecked">;
}

const CLAIM_RULES: Record<ClaimKind, ClaimRule> = {
  tests_pass: { kinds: ["test"], runs: "tests", unproven: "unsupported" },
  build_ok: { kinds: ["build"], runs: "build", unproven: "unsupported" },
  verified: { kinds: ["test", "build", "lint"], runs: "test, build or lint", unproven: "unsupported" },
  fixed: { kinds: ["test", "build", "lint"], runs: "test, build or lint", unproven: "unchecked" },
  done: { kinds: ["test", "build", "lint"], runs: "test, build or lint", unproven: "unchecked" },
};

type AgentRecord = { kind: "passed" | "failed"; run: ProofCommand } | { kind: "none"; note: string | null };

/** Matching runs that settle nothing, named in the reason. */
const UNSETTLED: Partial<Record<Outcome, string>> = { denied: "denied", background: "in background, no result", unknown: "exit unknown, piped or chained", elsewhere: "in another directory", cwd_unknown: "directory unreported after a previous directory change", stale: "recorded by an older version" };

// Only a test, build or lint run backs a claim: an `ls`, `cat` or `git status` that exited 0 shows nothing about the change.
function agentRecordFor(rule: ClaimRule, after: readonly ProofCommand[]): AgentRecord {
  const settled = after.filter((c) => c.outcome === "ok" || c.outcome === "failed");
  // Each accepted kind's last run decides: any failed one contradicts, else the latest passed one holds.
  const lastPerKind = rule.kinds.flatMap((kind) => settled.filter((c) => c.kind === kind).slice(-1)).sort((a, b) => a.index - b.index);
  const failed = lastPerKind.filter((c) => c.outcome === "failed").at(-1);
  if (failed) return { kind: "failed", run: failed };
  const passed = lastPerKind.at(-1);
  if (passed) return { kind: "passed", run: passed };
  const unsettled = after.filter((c) => UNSETTLED[c.outcome] && rule.kinds.includes(c.kind)).at(-1);
  return { kind: "none", note: unsettled ? `${UNSETTLED[unsettled.outcome]}: ${quote(unsettled.command)}` : null };
}

function quote(command: string): string {
  const line = command.split("\n", 1)[0]!;
  if (line.length > 80) return `${line.slice(0, 77)}...`;
  return line === command ? line : `${line} ...`;
}

/**
 * The plugin check, held to the agent's rules: it counts for a claim only when it runs that claim's kind in this
 * directory and its exit status is that run's own. A failed `a && b` whose every command is such a run still failed.
 */
function countedCheck(plugin: PluginCheck, rule: ClaimRule): { passed: boolean } | { note: string } {
  const result = commandResult(plugin.command, undefined, plugin.passed ? 0 : 1);
  const runs = result.runs.filter((run) => rule.kinds.includes(run.kind));
  const notCounted = (why: string) => ({ note: `check not counted, ${quote(plugin.command)} ${why}` });
  if (runs.length === 0) return notCounted(`runs no ${rule.runs}`);
  if (result.runs.some((run) => run.cwd !== null)) return notCounted("runs in another directory");
  if (runs.every((run) => run.status === "own")) return { passed: runs.every((run) => run.exitCode === 0) };
  if (!plugin.passed) {
    const onSuccess = commandResult(plugin.command, undefined, 0);
    const allRuns = onSuccess.runs.length === shellSegments(plugin.command).length && onSuccess.runs.every((run) => run.status === "own" && rule.kinds.includes(run.kind));
    if (allRuns) return { passed: false };
  }
  return notCounted("does not return its own exit status (piped, chained or in the background)");
}

function verdictOf(record: AgentRecord, plugin: PluginCheck | null, unproven: ClaimRule["unproven"], scope: "this turn" | "after the last edit"): Pick<ClaimVerdict, "verdict" | "reason"> {
  switch (record.kind) {
    case "failed": {
      const exit = record.run.exitCode !== null ? ` (exit ${record.run.exitCode})` : "";
      return { verdict: "contradicted", reason: `last ${record.run.kind} command failed: ${quote(record.run.command)}${exit}` };
    }
    case "passed":
      if (plugin?.passed === false) return { verdict: "mismatch", reason: `agent's run passed (${quote(record.run.command)}), check failed: ${quote(plugin.command)}` };
      return { verdict: "verified", reason: `${quote(record.run.command)} passed` };
    case "none":
      if (!plugin) return { verdict: unproven, reason: `no matching command ran ${scope}${record.note ? ` (${record.note})` : ""}` };
      return { verdict: plugin.passed ? "verified" : "check_failed", reason: `agent ran none, check ${plugin.passed ? "passed" : "failed"}: ${quote(plugin.command)}` };
  }
}

export function judgeClaims(claims: Claim[], evidence: Pick<TurnEvidence, "commands" | "lastEditIndex">, plugin: PluginCheck | null): ClaimVerdict[] {
  const { lastEditIndex } = evidence;
  const after = evidence.commands.filter((c) => lastEditIndex === null || c.index > lastEditIndex);
  const scope = lastEditIndex === null ? "this turn" : "after the last edit";
  return claims.map((claim) => {
    const rule = CLAIM_RULES[claim.kind];
    const record = agentRecordFor(rule, after);
    if (!plugin) return { ...claim, ...verdictOf(record, null, rule.unproven, scope) };
    const check = countedCheck(plugin, rule);
    if ("passed" in check) return { ...claim, ...verdictOf(record, { command: plugin.command, passed: check.passed }, rule.unproven, scope) };
    const withNote = record.kind === "none" ? { kind: "none" as const, note: record.note ? `${record.note}; ${check.note}` : check.note } : record;
    return { ...claim, ...verdictOf(withNote, null, rule.unproven, scope) };
  });
}

const normalize = (command: string) => command.replace(/\s+/g, " ").trim();

/** Did the agent run the configured check itself? Matches the check command as a substring of a shell command. */
export function agentRanCheck(commands: ProofCommand[], checkCommand: string | null): ProofCommand | null {
  if (!checkCommand) return null;
  const wanted = normalize(checkCommand);
  return commands.filter((c) => normalize(c.command).includes(wanted)).at(-1) ?? null;
}

const settles = (c: ProofCommand) => c.outcome === "ok" || c.outcome === "failed";

/**
 * The judge sees every command; the report stores at most MAX_COMMANDS. Re-run judges the stored list again, so it keeps
 * what a verdict can rest on (per kind the last settled and the last unsettled run after the last edit, the agent's run
 * of the check), then the most recent.
 */
function storedCommands(commands: readonly ProofCommand[], lastEditIndex: number | null, agentCheck: ProofCommand | null): ProofCommand[] {
  if (commands.length <= MAX_COMMANDS) return [...commands];
  const after = commands.filter((c) => lastEditIndex === null || c.index > lastEditIndex);
  const keep = new Set<ProofCommand>();
  const add = (c: ProofCommand | null | undefined) => c && keep.add(c);
  for (const kind of ["test", "build", "lint"] as const) {
    add(after.filter((c) => c.kind === kind && settles(c)).at(-1));
    add(after.filter((c) => c.kind === kind && UNSETTLED[c.outcome]).at(-1));
  }
  add(agentCheck);
  for (let i = commands.length - 1; i >= 0 && keep.size < MAX_COMMANDS; i--) keep.add(commands[i]!);
  return commands.filter((c) => keep.has(c));
}

export function buildProof(evidence: TurnEvidence, checkCommand: string | null, plugin: PluginCheck | null, provider: string): ProofReport {
  const agentCheck = agentRanCheck(evidence.commands, checkCommand);
  return {
    provider,
    commands: storedCommands(evidence.commands, evidence.lastEditIndex, agentCheck),
    commandsTotal: evidence.commandsTotal,
    failedTools: evidence.failedTools,
    deniedTools: evidence.deniedTools,
    files: evidence.files.slice(0, MAX_FILES),
    testFiles: evidence.files.filter(isTestFile),
    lastEditIndex: evidence.lastEditIndex,
    check: { command: checkCommand, agentRan: agentCheck ? { exitCode: agentCheck.exitCode, outcome: agentCheck.outcome } : null, pluginPassed: plugin ? plugin.passed : null },
    claims: judgeClaims(evidence.claims ?? matchClaims(evidence.finalMessage), evidence, plugin),
    rules: PROOF_RULES,
  };
}

/**
 * The stored record, for Re-run. A proof from older rules kept neither each call's directory nor every command after a
 * test (a dropped `sed -i` would have ended the scope), so its passes no longer count: Re-run leans on the check, which
 * runs again. A recorded failure stays one, and a stored shell write still ends the edit scope.
 */
export function evidenceFromProof(proof: ProofReport): TurnEvidence {
  const { commandsTotal, failedTools, deniedTools } = proof;
  let { commands, lastEditIndex } = proof;
  if (proof.rules !== PROOF_RULES) {
    commands = proof.commands.map((c) => {
      if (commandResult(c.command, undefined, null).writes && c.outcome !== "denied" && (lastEditIndex === null || c.index > lastEditIndex)) lastEditIndex = c.index;
      return c.outcome === "ok" && c.kind !== "other" ? { ...c, exitCode: null, outcome: "stale" as const } : c;
    });
  }
  const files = [...new Set([...proof.files, ...proof.testFiles])];
  const claims = proof.claims.flatMap(({ kind, text }) => proof.rules === PROOF_RULES || matchClaims(text).some((claim) => claim.kind === kind) ? [{ kind, text }] : []);
  return { commands, commandsTotal, failedTools, deniedTools, files, lastEditIndex, finalMessage: null, claims };
}
