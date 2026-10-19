import { isAbsolute, relative, resolve } from "node:path";
import type { ClaimKind, ClaimVerdict, Outcome, ProofCommand, ProofReport, Verdict } from "../shared/report";
import { commandKind, commandShape, isTestFile } from "./command-kind";
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

function exitCodeOf(call: ToolCall): number | null {
  const own = ownExitCodeOf(call);
  if (call.detail.type === "shell" && call.status !== "failed" && (own === null || own === 0)) {
    return echoedExitCode(call.detail.command, call.detail.output) ?? own;
  }
  return own;
}

/**
 * Agents often end a command with `; echo "exit: $?"` (Claude Code did on every test run seen live), so the tool
 * call succeeds whatever the test returned. Read the echoed status back from the line that final echo printed.
 */
function echoedExitCode(command: string, output: string | undefined): number | null {
  const echo = /\becho\s+["']?([^"'$\n]*)\$\?["']?\s*$/.exec(command);
  if (!echo || !output) return null;
  const label = echo[1]!.trim();
  const lines = output.split("\n").map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith(label)) continue;
    const value = /^(-?\d+)$/.exec(lines[i]!.slice(label.length).trim());
    if (value) return Number(value[1]);
  }
  return null;
}

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

export function extractEvidence(timeline: readonly AgentTimelineItem[]): TurnEvidence {
  const turn = timeline.filter(wellFormed);
  const commands: ProofCommand[] = [];
  const failedTools: TurnEvidence["failedTools"] = [];
  const deniedTools: TurnEvidence["deniedTools"] = [];
  const files = new Set<string>();
  let lastEditIndex: number | null = null;
  let finalMessage: string | null = null;
  const isTwin = codexDeclinedTwin(turn);
  const backgroundReports = new Set<number>();
  turn.forEach((item, index) => {
    if (item.type === "assistant_message") finalMessage = item.text;
    if (item.type !== "tool_call" || isTwin(item) || backgroundReports.has(index)) return;
    if (item.detail.type === "shell") {
      const shape = commandShape(item.detail.command);
      const taskId = backgroundTaskId(item);
      const end = taskId === null ? null : backgroundEnd(turn, index, item, taskId);
      if (end) backgroundReports.add(end.reportIndex);
      let exitCode = taskId === null ? exitCodeOf(item) : (end?.exitCode ?? null);
      let outcome = taskId === null ? outcomeOf(item, exitCode) : (end?.outcome ?? "background");
      // A check whose status the line does not return (`npx vitest run | tail -5`, `npm test || true`) neither passed nor failed.
      if (shape.kind !== "other" && shape.status === "unknown" && (outcome === "ok" || outcome === "failed")) {
        exitCode = null;
        outcome = "unknown";
      }
      commands.push({ command: item.detail.command, kind: shape.kind, index, exitCode, outcome });
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
  return { commands, commandsTotal: commands.length, failedTools, deniedTools, files: [...files], lastEditIndex, finalMessage };
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
  { kind: "tests_pass", re: /\b(all (?:the )?(?:\d+ )?tests? (?:are )?(?:now )?(?:pass(?:es|ing)?|green|succeed)|tests? (?:now )?(?:pass(?:es|ing)?|(?:are|is) (?:now )?(?:passing|green))|test suite (?:now )?pass(?:es)?|\d+ (?:tests? )?passed)\b/i },
  { kind: "build_ok", re: /\b(build (?:now )?(?:succeeds|passes|is green|is clean)|builds? (?:cleanly|successfully)|(?:compiles|type-?checks?) (?:cleanly|without errors|successfully)|no type errors)\b/i },
  { kind: "verified", re: /\b(verified|confirmed (?:it|that|the fix)|i (?:ran|tested) (?:it|the|them))\b/i },
  { kind: "fixed", re: /\b(fixed|is now resolved|resolved the)\b/i },
  { kind: "done", re: /^(?:done|all done|complete)\b|\b(task is (?:done|complete)|everything is (?:done|working)|all set)\b/i },
];
// A sentence that hedges, negates, or plans is not a claim.
const SKIP_RE = /\b(not|\w+n['’]t|no longer|never|fail(?:s|ed|ing)?|unable|cannot|could not|if|once|should|would|will|may|might|please|try|let me|i['’]ll|todo|to be)\b|\?$/i;
// A zero failure count ("2 passed, 0 failed", "fail 0") is part of a passing summary, not a negation.
const ZERO_FAILURES_RE = /\b(?:(?:0|zero|no|none)\s+(?:tests?\s+)?fail(?:s|ed|ing)?|fail(?:s|ed|ing)?:?\s+0)\b/gi;

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
    if (SKIP_RE.test(sentence.replace(ZERO_FAILURES_RE, ""))) continue;
    for (const { kind, re } of CLAIM_PATTERNS) {
      if (found.has(kind)) continue;
      const m = re.exec(sentence);
      if (m) found.set(kind, { kind, text: sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence });
    }
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
  anyExitZeroIsOwnCheck: boolean;
  unproven: Extract<Verdict, "unsupported" | "unchecked">;
}

const CLAIM_RULES: Record<ClaimKind, ClaimRule> = {
  tests_pass: { kinds: ["test"], runs: "tests", anyExitZeroIsOwnCheck: false, unproven: "unsupported" },
  build_ok: { kinds: ["build"], runs: "build", anyExitZeroIsOwnCheck: false, unproven: "unsupported" },
  verified: { kinds: ["test", "build", "lint"], runs: "test, build or lint", anyExitZeroIsOwnCheck: true, unproven: "unsupported" },
  fixed: { kinds: ["test", "build", "lint"], runs: "test, build or lint", anyExitZeroIsOwnCheck: false, unproven: "unchecked" },
  done: { kinds: ["test", "build", "lint"], runs: "test, build or lint", anyExitZeroIsOwnCheck: false, unproven: "unchecked" },
};

type AgentRecord = { kind: "passed" | "failed" | "own_check"; run: ProofCommand } | { kind: "none"; note: string | null };

/** Matching runs that settle nothing, named in the reason. */
const UNSETTLED: Partial<Record<Outcome, string>> = { denied: "denied", background: "in background, no result", unknown: "exit unknown, piped or chained" };

const knownFailure = (c: ProofCommand) => c.outcome === "failed" && c.exitCode !== null && c.exitCode !== 0;

function agentRecordFor(rule: ClaimRule, after: readonly ProofCommand[]): AgentRecord {
  const settled = after.filter((c) => c.outcome === "ok" || c.outcome === "failed");
  // Each accepted kind's last run decides: any failed one contradicts, else the latest passed one holds.
  const lastPerKind = rule.kinds.flatMap((kind) => settled.filter((c) => c.kind === kind).slice(-1)).sort((a, b) => a.index - b.index);
  const failed = lastPerKind.filter((c) => c.outcome === "failed").at(-1);
  if (failed) return { kind: "failed", run: failed };
  const passed = lastPerKind.at(-1);
  if (passed) return { kind: "passed", run: passed };
  const own = rule.anyExitZeroIsOwnCheck ? settled.filter((c) => c.outcome === "ok").at(-1) : undefined;
  // A command that failed after the agent's last exit-0 one means its own check did not hold.
  const failedAfter = own ? settled.filter((c) => c.index > own.index && knownFailure(c)).at(-1) : undefined;
  if (failedAfter) return { kind: "none", note: `failed after the last exit-0 one: ${quote(failedAfter.command)} (exit ${failedAfter.exitCode})` };
  if (own) return { kind: "own_check", run: own };
  const unsettled = after.filter((c) => UNSETTLED[c.outcome] && rule.kinds.includes(c.kind)).at(-1);
  return { kind: "none", note: unsettled ? `${UNSETTLED[unsettled.outcome]}: ${quote(unsettled.command)}` : null };
}

function quote(command: string): string {
  const line = command.split("\n", 1)[0]!;
  if (line.length > 80) return `${line.slice(0, 77)}...`;
  return line === command ? line : `${line} ...`;
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
    case "own_check":
      if (!plugin) return { verdict: "checked", reason: `${quote(record.run.command)} exited 0` };
      if (plugin.passed) return { verdict: "verified", reason: `check passed: ${quote(plugin.command)}` };
      return { verdict: "check_failed", reason: `agent's ${quote(record.run.command)} exited 0, check failed: ${quote(plugin.command)}` };
    case "none":
      if (!plugin) return { verdict: unproven, reason: `no matching command ran ${scope}${record.note ? ` (${record.note})` : ""}` };
      return { verdict: plugin.passed ? "verified" : "check_failed", reason: `agent ran none, check ${plugin.passed ? "passed" : "failed"}: ${quote(plugin.command)}` };
  }
}

export function judgeClaims(claims: Claim[], evidence: Pick<TurnEvidence, "commands" | "lastEditIndex">, plugin: PluginCheck | null): ClaimVerdict[] {
  const { lastEditIndex } = evidence;
  const after = evidence.commands.filter((c) => lastEditIndex === null || c.index > lastEditIndex);
  const scope = lastEditIndex === null ? "this turn" : "after the last edit";
  const pluginKind = plugin ? commandKind(plugin.command) : null;
  return claims.map((claim) => {
    const rule = CLAIM_RULES[claim.kind];
    const record = agentRecordFor(rule, after);
    // The plugin check speaks only for claims that accept its kind of command.
    if (!plugin || rule.kinds.includes(pluginKind!)) return { ...claim, ...verdictOf(record, plugin, rule.unproven, scope) };
    const notCounted = `check not counted, ${quote(plugin.command)} runs no ${rule.runs}`;
    const withNote = record.kind === "none" ? { kind: "none" as const, note: record.note ? `${record.note}; ${notCounted}` : notCounted } : record;
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
 * what a verdict can rest on (per kind the last settled and the last unsettled run after the last edit, the last exit-0
 * run and the last known failure after it, the agent's run of the check), then the most recent.
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
  add(after.filter((c) => c.outcome === "ok").at(-1));
  add(after.filter(knownFailure).at(-1));
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
  };
}

export function evidenceFromProof(proof: ProofReport): TurnEvidence {
  const { commands, commandsTotal, failedTools, deniedTools, lastEditIndex } = proof;
  const files = [...new Set([...proof.files, ...proof.testFiles])];
  return { commands, commandsTotal, failedTools, deniedTools, files, lastEditIndex, finalMessage: null, claims: proof.claims.map(({ kind, text }) => ({ kind, text })) };
}
