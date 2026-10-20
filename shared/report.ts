import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Renderer kinds must match the app's contribution id rule /^[a-z][a-z0-9-]*$/ (packages/app/src/plugins/evaluate.ts:40).
// The daemon accepts any kind on append, so a dotted kind appends fine and then breaks the whole client bundle.
export const REPORT_KIND = "turn-report-card";
export const REPORT_VERSION = 3;

export const MAX_TAIL_CHARS = 2_000;
/** Reports the plugin keeps; the board asks for all of them. */
export const MAX_REPORTS = 200;
export const BOARD_LIMIT = MAX_REPORTS;
/** Notes the client turns into labels: "Collisions need a git repository", "Check busy". */
export const NOT_A_GIT_REPOSITORY = "not a git repository";
export const CHECK_ALREADY_RUNNING = "a check is already running for this agent";
export const MAX_FILES_PER_PEER = 20;
export const MAX_PEERS = 8;
export const MAX_ARTIFACTS = 12;

// needs_approval: the check comes from paseo.json, and the user has not approved this exact command for this workspace.
export const VerifyStateSchema = z.enum(["skipped", "needs_approval", "running", "passed", "failed", "retrying", "gave_up", "busy"]);
export type VerifyState = z.infer<typeof VerifyStateSchema>;

export const VerifySchema = z.object({
  state: VerifyStateSchema,
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  tail: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  note: z.string().nullable(),
});
export type VerifyReport = z.infer<typeof VerifySchema>;

/** Control (other than tab and new line), zero-width, invisible and bidi characters: they can hide or reorder what a command runs. */
const HIDDEN_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E0FFF}]/u;
export const hasHiddenCharacters = (text: string) => HIDDEN_CHARACTER.test(text);
/** Each hidden character written out as a visible escape: \u202E, or \u{E0041} past the BMP. */
export const escapeHidden = (text: string) =>
  text.replace(new RegExp(HIDDEN_CHARACTER.source, "gu"), (c) => {
    const hex = c.codePointAt(0)!.toString(16).toUpperCase();
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });

export const SectionStateSchema = z.enum(["pending", "done", "skipped", "error"]);
export type SectionState = z.infer<typeof SectionStateSchema>;

export const CollisionFileSchema = z.object({ path: z.string(), kind: z.string() });
export type CollisionFile = z.infer<typeof CollisionFileSchema>;

export const CollisionPeerSchema = z.object({
  agentId: z.string(),
  agentTitle: z.string(),
  branch: z.string(),
  files: z.array(CollisionFileSchema),
  moreFiles: z.number(),
});
export type CollisionPeer = z.infer<typeof CollisionPeerSchema>;

export const CollisionsSchema = z.object({
  state: SectionStateSchema,
  peersChecked: z.number(),
  items: z.array(CollisionPeerSchema),
  durationMs: z.number(),
  note: z.string().nullable(),
});
export type CollisionsReport = z.infer<typeof CollisionsSchema>;

export const ArtifactSchema = z.object({
  path: z.string(),
  kind: z.string(),
  size: z.number(),
  status: z.enum(["new", "changed"]),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactsSchema = z.object({
  state: SectionStateSchema,
  items: z.array(ArtifactSchema),
  more: z.number(),
  note: z.string().nullable(),
  // The document viewer plugin was enabled when the turn ended, so the card folds the list into one line. Every document is
  // in `items` either way. Absent on reports from 0.1.x and when the viewer was off: the list shows in full.
  docViewer: z.object({ pluginId: z.string() }).optional(),
});
export type ArtifactsReport = z.infer<typeof ArtifactsSchema>;

export const ClaimKindSchema = z.enum(["tests_pass", "build_ok", "verified", "fixed", "done"]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

// background: Claude Code moved the command to the background, and no end was reported in the turn.
// unknown: a test, build or lint run whose exit status the line does not return (piped without pipefail, `|| true`, more commands after it).
// elsewhere: a test, build or lint run outside the agent's repository (`cd /other && npm test`, or a Codex call cwd elsewhere).
// stale: a pass recorded by v0.1.0, which kept neither the call's directory nor every command after it; Re-run does not count it.
export const OutcomeSchema = z.enum(["ok", "failed", "denied", "canceled", "running", "background", "unknown", "elsewhere", "cwd_unknown", "stale"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const ProofCommandSchema = z.object({
  command: z.string(),
  kind: z.enum(["test", "build", "lint", "other"]),
  exitCode: z.number().nullable(),
  outcome: OutcomeSchema,
  index: z.number(),
});
export type ProofCommand = z.infer<typeof ProofCommandSchema>;

export const VerdictSchema = z.enum(["verified", "checked", "unchecked", "unsupported", "check_failed", "mismatch", "contradicted"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ClaimVerdictSchema = z.object({
  kind: ClaimKindSchema,
  text: z.string(),
  verdict: VerdictSchema,
  reason: z.string(),
});
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const ProofSchema = z.object({
  provider: z.string(),
  commands: z.array(ProofCommandSchema),
  commandsTotal: z.number(),
  failedTools: z.array(z.object({ name: z.string(), summary: z.string() })),
  // Denied tools other than shell commands (a denied Write, for example); denied commands are in `commands`.
  deniedTools: z.array(z.object({ name: z.string(), summary: z.string() })).default([]),
  files: z.array(z.string()),
  testFiles: z.array(z.string()),
  lastEditIndex: z.number().nullable(),
  check: z.object({
    command: z.string().nullable(),
    agentRan: z.object({ exitCode: z.number().nullable(), outcome: OutcomeSchema }).nullable(),
    pluginPassed: z.boolean().nullable(),
  }),
  claims: z.array(ClaimVerdictSchema),
  /** The judging rules the proof was built with; absent for proofs from v0.1.0. */
  rules: z.number().int().optional(),
});
export type ProofReport = z.infer<typeof ProofSchema>;

export const TurnReportSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  workspaceId: z.string().nullable(),
  turnId: z.string().nullable(),
  cwd: z.string(),
  branch: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
  verify: VerifySchema,
  collisions: CollisionsSchema,
  artifacts: ArtifactsSchema,
  proof: ProofSchema.nullable().optional(),
});
export type TurnReport = z.infer<typeof TurnReportSchema>;

// A v1 proof was judged by older rules, so a v1 report loads without it.
const TurnReportV1Schema = TurnReportSchema.extend({ proof: z.unknown().optional().transform((): null => null) });

/** Proofs built today; older ones are read again before a re-run judges them (server/proof.ts evidenceFromProof). */
export const PROOF_RULES = 2;

export const OLDER_RULES_NOTE = "judged by an older version of the plugin; Re-run to judge again";

// A v2 proof's passes may rest on rules since fixed (an echoed `$?` it could not read, an `ls` as the agent's own check,
// a shell edit after the test, a check piped into tail). Its failures stand; a pass reads "not checked" until Re-run.
const TurnReportV2Schema = TurnReportSchema.transform((report): TurnReport => {
  if (!report.proof) return report;
  const claims = report.proof.claims.map((claim) =>
    claim.verdict === "verified" || claim.verdict === "checked" ? { ...claim, verdict: "unchecked" as const, reason: `${claim.reason} (${OLDER_RULES_NOTE})` } : claim,
  );
  return { ...report, proof: { ...report.proof, claims } };
});

export const REPORT_SCHEMAS: ReadonlyMap<number, z.ZodType<TurnReport>> = new Map<number, z.ZodType<TurnReport>>([
  [1, TurnReportV1Schema],
  [2, TurnReportV2Schema],
  [REPORT_VERSION, TurnReportSchema],
]);

export const recentReportsRpc = defineRpc({
  name: "reports.recent",
  input: z.object({ workspaceId: z.string().nullable(), limit: z.number().int().min(1).max(MAX_REPORTS) }),
  output: z.object({ reports: z.array(TurnReportSchema) }),
});

export const rerunRpc = defineRpc({
  name: "reports.rerun",
  input: z.object({ reportId: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const approveCheckRpc = defineRpc({
  name: "checks.approve",
  input: z.object({ reportId: z.string(), command: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const settingsDefinition = defineSettings({
  id: "turn-report",
  scope: "host",
  version: 1,
  schema: z.object({
    verify: z.boolean().default(true),
    checkCommand: z.string().default(""),
    // Auto-retry is opt-in: provider Stop hooks already cover "block done and feed back" inside one agent.
    maxRetries: z.number().int().min(0).max(5).default(0),
    timeoutSeconds: z.number().int().min(5).max(3600).default(600),
    collisions: z.boolean().default(true),
    artifacts: z.boolean().default(true),
    openWithPluginId: z.string().default("paseo-doc-viewer"),
  }),
});
export type TurnReportSettings = z.infer<typeof settingsDefinition.schema>;

export const DEFAULT_SETTINGS: TurnReportSettings = settingsDefinition.schema.parse({});
