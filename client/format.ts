import type { Artifact, ClaimVerdict, Outcome, ProofReport, TurnReport, Verdict, VerifyReport, VerifyState } from "../shared/report";
import { CHECK_ALREADY_RUNNING, escapeHidden, hasHiddenCharacters, NOT_A_GIT_REPOSITORY } from "../shared/report";
import { commandResult } from "../shared/command-kind";

export type Tone = "success" | "danger" | "warning" | "muted";

export function verifyTone(state: VerifyState): Tone {
  switch (state) {
    case "passed":
      return "success";
    case "failed":
    case "gave_up":
      return "danger";
    case "retrying":
    case "busy":
    case "running":
      return "warning";
    case "skipped":
    case "needs_approval":
      return "muted";
  }
}

/** The check ran to an end (passed, failed, timed out), so Re-run applies, whether or not it printed anything. */
export function checkRan(state: VerifyState): boolean {
  return state === "passed" || state === "failed" || state === "gave_up" || state === "busy" || state === "retrying";
}

export function verifyLabel(report: TurnReport): string {
  const v = report.verify;
  const attempt = v.attempt > 0 && v.maxAttempts > 1 ? ` (${v.attempt}/${v.maxAttempts})` : "";
  switch (v.state) {
    case "passed":
      return `Check passed${attempt}`;
    case "failed":
      return `Check failed${attempt}`;
    case "retrying":
      return `Check failed${attempt}, sent to agent`;
    case "gave_up":
      return `Check failed${attempt}, gave up`;
    case "busy":
      return `Check failed${attempt}, not sent`;
    case "running":
      return "Running check";
    case "skipped":
      return v.note === CHECK_ALREADY_RUNNING ? "Check busy" : "No check";
    case "needs_approval":
      return "Check needs approval";
  }
}

export function collisionFileCount(report: TurnReport): number {
  const paths = new Set<string>();
  for (const peer of report.collisions.items) for (const file of peer.files) paths.add(file.path);
  return paths.size + report.collisions.items.reduce((n, p) => n + p.moreFiles, 0);
}

export function collisionLabel(report: TurnReport): string {
  const c = report.collisions;
  if (c.state === "pending") return "Checking collisions";
  if (c.state === "skipped") return c.note === NOT_A_GIT_REPOSITORY ? "Collisions need a git repository" : "Collisions off";
  if (c.state === "error") return "Collision check failed";
  if (c.items.length === 0) return c.peersChecked === 0 ? "No other agents" : `No conflicts (${c.peersChecked} checked)`;
  const files = collisionFileCount(report);
  const who = c.items.length === 1 ? c.items[0].agentTitle : `${c.items.length} agents`;
  return `${files} ${files === 1 ? "file conflicts" : "files conflict"} with ${who}`;
}

const documentCount = (n: number) => `${n} ${n === 1 ? "document" : "documents"}`;

export function artifactLabel(report: TurnReport): string {
  const a = report.artifacts;
  if (a.state === "pending") return "Scanning documents";
  if (a.state !== "done") return "Documents off";
  const n = a.items.length + a.more;
  return n === 0 ? "No documents" : documentCount(n);
}

export interface DocumentsSection {
  /** The count as the one line that opens the list; null when the list shows in full. */
  line: string | null;
  items: readonly Artifact[];
  more: number;
}

/** With the viewer plugin enabled when the turn ended, the list folds into its count until opened. Never fewer documents, only folded. */
export function documentsSection(report: TurnReport, open: boolean): DocumentsSection {
  const { items, more, docViewer } = report.artifacts;
  const total = items.length + more;
  if (total === 0) return { line: null, items: [], more: 0 };
  if (!docViewer) return { line: null, items, more };
  return { line: documentCount(total), items: open ? items : [], more: open ? more : 0 };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const TIMEOUTS = [60, 120, 300, 600, 1200, 1800, 3600];

/** Check timeout choices for the settings screen; a value set elsewhere stays in the list. */
export function timeoutOptions(current: number): { label: string; value: string }[] {
  const seconds = TIMEOUTS.includes(current) ? TIMEOUTS : [...TIMEOUTS, current].sort((a, b) => a - b);
  return seconds.map((s) => ({ label: s % 60 === 0 ? `${s / 60} min` : `${s} s`, value: String(s) }));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const ARTIFACT_ICONS: Readonly<Record<string, string>> = {
  pdf: "FileText",
  docx: "FileText",
  xlsx: "FileSpreadsheet",
  csv: "FileSpreadsheet",
  parquet: "Database",
  pptx: "Presentation",
  video: "FileVideoCamera",
  audio: "FileAudio",
  image: "Image",
  jsonl: "FileJson",
  ipynb: "NotebookPen",
};

/**
 * One status per report for the board, the worst of check, collisions and proof: red = check failed or a claim
 * contradicted, amber = conflicts or a claim to look at, green = check passed, muted = no check or still running.
 * A claim waits for the check (its verdict can still change), except a contradiction, which the check cannot undo.
 */
export function overallTone(report: TurnReport): Tone {
  const v = verifyTone(report.verify.state);
  const proof = report.proof ? proofTone(report.proof) : "muted";
  if (v === "danger" || report.verify.state === "busy" || report.verify.state === "retrying" || proof === "danger") return "danger";
  if (report.collisions.items.length > 0) return "warning";
  if (report.verify.state === "running" || report.collisions.state === "pending") return "muted";
  if (proof === "warning") return "warning";
  return v === "success" ? "success" : "muted";
}

/** Latest report per agent, newest first (input is newest first). */
export function latestPerAgent(reports: readonly TurnReport[]): TurnReport[] {
  const seen = new Set<string>();
  return reports.filter((r) => (seen.has(r.agentId) ? false : (seen.add(r.agentId), true)));
}

/** Each agent's latest report counts once, under its overall tone. */
export function boardSummary(reports: readonly TurnReport[]): { green: number; amber: number; red: number; other: number; text: string } {
  const tones = latestPerAgent(reports).map(overallTone);
  const count = (tone: Tone) => tones.filter((t) => t === tone).length;
  const [green, amber, red, other] = [count("success"), count("warning"), count("danger"), count("muted")];
  const parts = [green ? `${green} green` : "", amber ? `${amber} amber` : "", red ? `${red} red` : "", other ? `${other} unchecked` : ""].filter(Boolean);
  return { green, amber, red, other, text: parts.length ? parts.join(", ") : "no reports" };
}

/** Sidebar footer: the most urgent non-empty count (red, amber, unchecked, green), or nothing when there are no reports. */
export function footerSummary(reports: readonly TurnReport[]): { text: string; tone: Tone } | null {
  const { red, amber, other, green } = boardSummary(reports);
  if (red) return { text: `${red} red`, tone: "danger" };
  if (amber) return { text: `${amber} amber`, tone: "warning" };
  if (other) return { text: `${other} unchecked`, tone: "muted" };
  if (green) return { text: `${green} green`, tone: "success" };
  return null;
}

const VERDICTS: Record<Verdict, { rank: number; label: string; summary: string; tone: Tone }> = {
  contradicted: { rank: 0, label: "contradicted", summary: "Claim contradicted", tone: "danger" },
  mismatch: { rank: 1, label: "agent and check disagree", summary: "Agent and check disagree", tone: "warning" },
  check_failed: { rank: 2, label: "check failed after claim", summary: "Check failed after claim", tone: "warning" },
  unsupported: { rank: 3, label: "unverified", summary: "Claim unverified", tone: "warning" },
  verified: { rank: 4, label: "verified", summary: "Claims hold", tone: "success" },
  checked: { rank: 5, label: "checked by the agent", summary: "Checked by the agent", tone: "muted" },
  unchecked: { rank: 6, label: "not checked", summary: "Claims not checked", tone: "muted" },
};

export const PROOF_ICONS: Readonly<Record<Tone, string>> = { danger: "ShieldX", warning: "ShieldAlert", success: "ShieldCheck", muted: "Shield" };

function worstVerdict(proof: ProofReport): Verdict | null {
  return proof.claims.reduce<Verdict | null>((worst, c) => (worst === null || VERDICTS[c.verdict].rank < VERDICTS[worst].rank ? c.verdict : worst), null);
}

export function proofTone(proof: ProofReport): Tone {
  const worst = worstVerdict(proof);
  return worst ? VERDICTS[worst].tone : "muted";
}

export function proofLabel(proof: ProofReport): string {
  const worst = worstVerdict(proof);
  return worst ? VERDICTS[worst].summary : "No claims";
}

export const claimTone = (claim: ClaimVerdict): Tone => VERDICTS[claim.verdict].tone;

const CLAIM_NAMES: Record<ClaimVerdict["kind"], string> = { tests_pass: "tests pass", build_ok: "build ok", verified: "verified", fixed: "fixed", done: "done" };

export function claimLine(claim: ClaimVerdict): string {
  // Reasons quote commands; a bidi or zero-width character in one must not reorder or hide the rest of the line.
  return `"${CLAIM_NAMES[claim.kind]}": ${VERDICTS[claim.verdict].label}, ${escapeHidden(claim.reason)}`;
}

export const OUTCOMES: Readonly<Record<Outcome, { icon: string; tone: Tone; label: string }>> = {
  ok: { icon: "CircleCheck", tone: "success", label: "ok" },
  failed: { icon: "CircleX", tone: "danger", label: "failed" },
  denied: { icon: "Ban", tone: "muted", label: "denied" },
  canceled: { icon: "CircleMinus", tone: "muted", label: "canceled" },
  running: { icon: "CircleMinus", tone: "muted", label: "running" },
  background: { icon: "Clock", tone: "muted", label: "in background" },
  unknown: { icon: "CircleHelp", tone: "muted", label: "exit unknown" },
  elsewhere: { icon: "CircleHelp", tone: "muted", label: "other directory" },
  cwd_unknown: { icon: "CircleHelp", tone: "muted", label: "directory unknown" },
  stale: { icon: "CircleHelp", tone: "muted", label: "not counted" },
};

export function proofFacts(proof: ProofReport): string {
  const count = (outcome: Outcome) => new Set(proof.commands.filter((c) => c.outcome === outcome).map((c) => c.index)).size;
  const denied = count("denied") + proof.deniedTools.length;
  const tally = [`${count("failed")} failed`, `${denied} denied`, `${count("background")} in background`, `${count("unknown")} exit unknown`, `${count("elsewhere")} in another directory`, `${count("cwd_unknown")} directory unknown`].filter((part) => !part.startsWith("0 "));
  const parts = [[`${proof.commandsTotal} command${proof.commandsTotal === 1 ? "" : "s"}`, ...tally].join(", ")];
  parts.push(`${proof.files.length} file${proof.files.length === 1 ? "" : "s"} written${proof.testFiles.length ? ` (${proof.testFiles.length} test)` : ""}`);
  if (proof.failedTools.length) parts.push(`${proof.failedTools.length} failed tool${proof.failedTools.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

const PLUGIN_CHECK_NOT_RUN: Partial<Record<VerifyState, string>> = { needs_approval: "plugin check needs approval", skipped: "plugin check skipped" };

/** Who ran the configured check: the agent inside the turn, the plugin after it, or both. */
export function checkProvenance(proof: ProofReport, verifyState: VerifyState): string | null {
  const { command, agentRan, pluginPassed } = proof.check;
  if (!command) return null;
  const agent = !agentRan
    ? "agent did not run it"
    : agentRan.outcome === "denied"
      ? "agent's run was denied"
      : agentRan.outcome === "background"
        ? "agent started it in the background, no result"
        : agentRan.outcome === "unknown"
          ? "agent ran it, exit unknown (piped or chained)"
          : agentRan.outcome === "elsewhere"
            ? "agent ran it in another directory"
            : agentRan.outcome === "cwd_unknown"
              ? "agent's directory is unknown after a directory change"
              : agentRan.outcome === "stale"
                ? "agent's run recorded by an older version, not counted"
                : `agent ran it${agentRan.exitCode !== null ? ` (exit ${agentRan.exitCode})` : agentRan.outcome === "failed" ? " (failed)" : ""}`;
  const plugin = pluginPassed === null ? (PLUGIN_CHECK_NOT_RUN[verifyState] ?? "plugin check pending") : `plugin ${pluginPassed ? "passed" : "failed"}`;
  return `${escapeHidden(command)}: ${agent}; ${plugin}`;
}

const UNCOUNTED_CHECK = "This command can hide failures or does not run a recognized check. Its exit status alone will not verify the agent's claims.";

/** The same rule the proof applies to the plugin check (server/proof.ts countedCheck), on success. */
function countsAsProof(command: string): boolean {
  const { runs } = commandResult(command, undefined, 0);
  return runs.some((run) => run.kind !== "other") && runs.every((run) => run.status === "own" && run.cwd === null);
}

/** The paseo.json command a card asks to approve, as shown: hidden characters escaped, and then no approval. */
export function approvalPrompt(verify: Pick<VerifyReport, "command">): { command: string; approvable: boolean; warning: string | null } {
  const command = verify.command ?? "";
  if (!hasHiddenCharacters(command)) return { command, approvable: true, warning: countsAsProof(command) ? null : UNCOUNTED_CHECK };
  return { command: escapeHidden(command), approvable: false, warning: "This command has hidden characters (control, zero-width or bidi), shown escaped. Fix paseo.json: it cannot be approved." };
}
