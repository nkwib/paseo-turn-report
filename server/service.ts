import { realpath } from "node:fs/promises";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { TurnReport, TurnReportSettings, VerifyReport } from "../shared/report";
import { CHECK_ALREADY_RUNNING, hasHiddenCharacters, MAX_REPORTS, REPORT_KIND, REPORT_VERSION, TurnReportSchema } from "../shared/report";
import { createCheckApprovals, type CheckApprovals } from "./approvals";
import type { AgentTimelineItem, PaseoApi } from "./host-types";
import { changedFiles, collectArtifacts, type TurnWindow } from "./artifacts";
import { buildProof, evidenceFromProof, extractEvidence, sliceTurn, toRepoPath, unreportedCwdAfter, type PluginCheck, type RunContext, type TurnEvidence } from "./proof";
import { detectCollisions, type PeerAgent } from "./collisions";
import { repoInfo } from "./git";
import { IDLE, stepRetry, type RetryEvent, type RetryState } from "./retry";
import { followUpMessage, resolveCheckCommand, runCheck } from "./verify";

const NOT_FOUND = `report not found: the plugin keeps the last ${MAX_REPORTS} reports`;

export interface TurnEnded {
  agent: PluginHookAgent;
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed" } | { kind: "canceled" };
  /** Whole conversation as the daemon has it (`agent.turn_ended`). */
  timeline?: readonly AgentTimelineItem[];
}

type ReportOrigin =
  | { kind: "turn" | "plugin_followup"; event: TurnEnded; reportId: string; startedAtMs: number | null; turn: AgentTimelineItem[] | null }
  | { kind: "rerun"; report: TurnReport };

type ReportSubject = Pick<TurnReport, "id" | "agentId" | "agentTitle" | "workspaceId" | "turnId" | "cwd"> & { provider: string; startedAtMs: number | null };

function subjectOf(origin: ReportOrigin): ReportSubject {
  if (origin.kind === "rerun") {
    const { id, agentId, agentTitle, workspaceId, turnId, cwd, startedAt, proof } = origin.report;
    return { id, agentId, agentTitle, workspaceId, turnId, cwd, provider: proof?.provider ?? "", startedAtMs: startedAt ? Date.parse(startedAt) : null };
  }
  const { agent, turnId } = origin.event;
  return { id: origin.reportId, agentId: agent.id, agentTitle: agent.title ?? agent.id.slice(0, 8), workspaceId: agent.workspaceId, turnId, cwd: agent.cwd, provider: agent.provider, startedAtMs: origin.startedAtMs };
}

function pluginCheckOf(verify: VerifyReport): PluginCheck | null {
  if (!verify.command || verify.state === "running" || verify.state === "skipped" || verify.exitCode === null) return null;
  return { command: verify.command, passed: verify.state === "passed" };
}

/** A timeline the plugin cannot read costs the card its proof, never the card. */
function evidenceOfTurn(turn: readonly AgentTimelineItem[], context: RunContext): TurnEvidence | null {
  try {
    return extractEvidence(turn, context);
  } catch (error) {
    log(`proof skipped: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Commands count for this workspace only when they ran in its repository (or in the agent's cwd outside git). */
async function evidenceOf(origin: ReportOrigin, root: string | null, cwd: string, window: TurnWindow | null): Promise<TurnEvidence | null> {
  const realCwd = await realpath(cwd).catch(() => cwd);
  const prior = origin.kind === "rerun" || !origin.turn ? [] : origin.event.timeline?.slice(0, origin.event.timeline.length - origin.turn.length) ?? [];
  const context = { root: root ?? realCwd, cwd, realCwd, cwdUnconfirmed: unreportedCwdAfter(prior) };
  if (origin.kind === "rerun") return origin.report.proof ? evidenceFromProof(origin.report.proof) : null;
  const evidence = origin.turn ? evidenceOfTurn(origin.turn, context) : null;
  if (!evidence || !root) return evidence;
  const fromGit = window ? await changedFiles(root, window) : [];
  return { ...evidence, files: [...new Set([...fromGit, ...evidence.files.map((path) => toRepoPath(path, { root, cwd, realCwd }))])] };
}

export interface ReportService {
  turnStarted(agent: PluginHookAgent, turnId: string | null): void;
  turnEnded(event: TurnEnded, paseo: PaseoApi): void;
  recent(workspaceId: string | null, limit: number): TurnReport[];
  rerun(reportId: string, paseo: PaseoApi): { ok: boolean; error: string | null };
  /** The user approved the paseo.json check shown on this report's card; it runs now and after each later turn. */
  approveCheck(reportId: string, command: string, paseo: PaseoApi): Promise<{ ok: boolean; error: string | null }>;
  idle(): Promise<void>;
  /** The plugin is stopping or reloading: kill running checks, then give pending cards a moment to settle. */
  dispose(): Promise<void>;
}

const log = (message: string) => console.log(`[turn-report] ${new Date().toISOString()} ${message}`);

export interface ReportPersistence {
  initial: TurnReport[];
  save(reports: TurnReport[]): void;
}

export function createReportService(
  readSettings: () => Promise<TurnReportSettings>,
  persistence: ReportPersistence = { initial: [], save: () => {} },
  approvals: CheckApprovals = createCheckApprovals(null),
): ReportService {
  const turnStarts = new Map<string, { at: number; turnId: string | null }>();
  // Timeline length at the previous turn end per agent: the next turn starts after it.
  const turnEnds = new Map<string, number>();
  const retry = new Map<string, RetryState>();
  const reports: TurnReport[] = persistence.initial.slice(0, MAX_REPORTS);
  const checking = new Set<string>();
  const malformed = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();
  // Reports being re-judged (Re-run, approval): a second request for one of them joins it instead of starting another.
  const rejudging = new Set<string>();

  function step(agentId: string, event: RetryEvent, maxRetries: number) {
    const result = stepRetry(retry.get(agentId) ?? IDLE, event, maxRetries);
    retry.set(agentId, result.next);
    return result;
  }

  function track(work: Promise<void>) {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  function rejudge(report: TurnReport, paseo: PaseoApi) {
    rejudging.add(report.id);
    const work = buildReport({ kind: "rerun", report }, paseo).catch((error) => log(`rerun failed: ${String(error)}`));
    track(work.finally(() => rejudging.delete(report.id)));
  }

  function store(report: TurnReport) {
    const at = reports.findIndex((r) => r.id === report.id);
    if (at >= 0) reports[at] = report;
    else reports.unshift(report);
    if (reports.length > MAX_REPORTS) reports.length = MAX_REPORTS;
    persistence.save(reports);
  }

  async function publish(paseo: PaseoApi, report: TurnReport) {
    store(report);
    try {
      // Same id replaces the row in place (pending -> final), so the agent gets one card per turn.
      await paseo.agents.ref(report.agentId).timeline.append({ type: "plugin", id: report.id, kind: REPORT_KIND, version: REPORT_VERSION, data: report });
    } catch (error) {
      log(`append failed for ${report.agentId}: ${String(error)}`);
    }
  }

  async function livePeers(paseo: PaseoApi, selfId: string): Promise<PeerAgent[]> {
    const { entries } = await paseo.agents.list({ page: { limit: 200 } });
    return entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.id !== selfId && !agent.archivedAt && agent.status !== "closed" && typeof agent.cwd === "string")
      .map((agent) => ({ agentId: agent.id, title: agent.title ?? agent.id.slice(0, 8), cwd: agent.cwd }));
  }

  async function runVerify(paseo: PaseoApi, report: TurnReport, settings: TurnReportSettings, update: (verify: VerifyReport) => Promise<void>) {
    const maxAttempts = settings.maxRetries + 1;
    const base: VerifyReport = { state: "skipped", command: null, exitCode: null, durationMs: 0, tail: "", attempt: 0, maxAttempts, note: null };
    if (!settings.verify) return update({ ...base, note: "verify is off in settings" });
    // The check runs through /bin/sh in its own process group.
    if (process.platform === "win32") return update({ ...base, note: "checks need macOS or Linux" });
    const check = await resolveCheckCommand(report.cwd, settings.checkCommand);
    if (!check) return update({ ...base, note: "no check command: set Check command in the Turn report settings, or add scripts.verify, scripts.check or scripts.test to paseo.json" });
    if (check.source !== "setting" && !(await approvals.isApproved(report.cwd, check.command))) {
      return update({ ...base, state: "needs_approval", command: check.command, note: check.source });
    }
    if (checking.has(report.agentId)) return update({ ...base, command: check.command, note: CHECK_ALREADY_RUNNING });
    checking.add(report.agentId);
    try {
      await update({ ...base, state: "running", command: check.command, note: check.source });
      const result = await runCheck(check.command, report.cwd, settings.timeoutSeconds * 1000, stopping.signal);
      if (result.stopped) return update({ ...base, command: check.command, note: "stopped: the plugin was stopped or reloaded" });
      const passed = result.exitCode === 0 && !result.timedOut;
      const decision = step(report.agentId, { type: passed ? "check_passed" : "check_failed" }, settings.maxRetries);
      log(`verify agent=${report.agentId.slice(0, 8)} attempt=${decision.attempt}/${maxAttempts} exit=${result.exitCode} ms=${result.durationMs} action=${decision.action}`);
      const done: VerifyReport = {
        ...base,
        command: check.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        tail: result.tail,
        attempt: decision.attempt,
        note: result.timedOut ? `timed out after ${settings.timeoutSeconds}s` : check.source,
        // With auto-retry off (maxRetries 0) a failure is just "failed", never "gave up".
        state: passed ? "passed" : decision.action === "give_up" && settings.maxRetries > 0 ? "gave_up" : "failed",
      };
      if (decision.action !== "send_followup") return update(done);
      const ref = paseo.agents.ref(report.agentId);
      await ref.refresh();
      if (ref.status !== "idle") {
        // No idle-only send on the SDK: sending now would steer or interrupt work the user started.
        step(report.agentId, { type: "send_failed" }, settings.maxRetries);
        return update({ ...done, state: "busy", note: `agent is ${ref.status ?? "unknown"}; failure not sent` });
      }
      await update({ ...done, state: "retrying" });
      try {
        await ref.send(followUpMessage({ command: check.command, exitCode: result.exitCode, attempt: decision.attempt, maxAttempts, tail: result.tail }), { activeTurnBehavior: "steer" });
        log(`sent follow-up to ${report.agentId.slice(0, 8)}`);
      } catch (error) {
        step(report.agentId, { type: "send_failed" }, settings.maxRetries);
        await update({ ...done, state: "busy", note: `send failed: ${String(error).slice(0, 200)}` });
      }
    } finally {
      checking.delete(report.agentId);
    }
  }

  /**
   * Conflicts are symmetric: when this turn finds (or no longer finds) a conflict with a peer,
   * update the peer's latest card too, so the board never shows a stale "no conflicts" on one side.
   */
  async function reflectOnPeers(paseo: PaseoApi, source: TurnReport, checkedAgentIds: string[]) {
    for (const peerId of new Set(checkedAgentIds)) {
      const latest = reports.find((r) => r.agentId === peerId);
      if (!latest) continue;
      const mine = source.collisions.items.find((item) => item.agentId === peerId);
      const others = latest.collisions.items.filter((item) => item.agentId !== source.agentId);
      const items = mine ? [...others, { agentId: source.agentId, agentTitle: source.agentTitle, branch: source.branch ?? "", files: mine.files, moreFiles: mine.moreFiles }] : others;
      if (JSON.stringify(items) === JSON.stringify(latest.collisions.items)) continue;
      await publish(paseo, { ...latest, collisions: { ...latest.collisions, state: "done", items, peersChecked: Math.max(latest.collisions.peersChecked, 1), note: `updated after ${source.agentTitle}'s turn` } });
    }
  }

  async function buildReport(origin: ReportOrigin, paseo: PaseoApi) {
    const settings = await readSettings();
    const { provider, startedAtMs, ...identity } = subjectOf(origin);
    const info = await repoInfo(identity.cwd);
    // A re-run judges the same turn, so it keeps the turn's end: documents written since then are not this turn's.
    const endedAt = origin.kind === "rerun" ? origin.report.endedAt : new Date().toISOString();
    const window = startedAtMs ? { startedAtMs, endedAtMs: Date.parse(endedAt) } : null;
    const evidence = await evidenceOf(origin, info?.toplevel ?? null, identity.cwd, window);
    const proof = evidence ? buildProof(evidence, null, null, provider) : null;
    if (origin.kind === "turn" && proof && proof.commandsTotal === 0 && proof.claims.length === 0 && proof.files.length === 0) {
      log(`skip ${identity.agentId.slice(0, 8)}: chat-only turn`);
      return;
    }
    let report: TurnReport = {
      ...identity,
      cwd: info?.toplevel ?? identity.cwd,
      branch: info?.branch ?? null,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      endedAt,
      verify: { state: settings.verify ? "running" : "skipped", command: null, exitCode: null, durationMs: 0, tail: "", attempt: 0, maxAttempts: settings.maxRetries + 1, note: null },
      collisions: { state: settings.collisions ? "pending" : "skipped", peersChecked: 0, items: [], durationMs: 0, note: null },
      artifacts: { state: settings.artifacts ? "pending" : "skipped", items: [], more: 0, note: null },
      proof,
    };
    // Serialize appends so a slower section never overwrites a newer state with an older one.
    let chain = publish(paseo, report);
    const patch = (fields: Partial<TurnReport>) => {
      report = { ...report, ...fields };
      // The plugin check is part of the proof: re-judge the claims whenever the verify section moves.
      if (fields.verify && evidence) report.proof = buildProof(evidence, fields.verify.command, pluginCheckOf(fields.verify), provider);
      const snapshot = report;
      chain = chain.then(() => publish(paseo, snapshot));
      return chain;
    };
    await Promise.all([
      runVerify(paseo, report, settings, (verify) => patch({ verify })).catch((error) =>
        patch({ verify: { ...report.verify, state: "skipped", note: `error: ${String(error).slice(0, 200)}` } }),
      ),
      settings.collisions
        ? livePeers(paseo, identity.agentId)
            .then((peers) => detectCollisions(report.cwd, peers))
            .then(({ checkedAgentIds, ...collisions }) => {
              void reflectOnPeers(paseo, { ...report, collisions }, checkedAgentIds);
              return patch({ collisions });
            })
            .catch((error) => patch({ collisions: { ...report.collisions, state: "error", note: String(error).slice(0, 300) } }))
        : null,
      settings.artifacts
        ? collectArtifacts(report.cwd, window)
            .then((artifacts) => patch({ artifacts }))
            .catch((error) => patch({ artifacts: { ...report.artifacts, state: "error", note: String(error).slice(0, 300) } }))
        : null,
    ]);
    await chain;
    log(
      `report ${identity.id} claims=${report.proof?.claims.map((c) => `${c.kind}:${c.verdict}`).join(",") || "none"} verify=${report.verify.state} collisions=${report.collisions.items.length} (${report.collisions.durationMs}ms) artifacts=${report.artifacts.items.length}`,
    );
  }

  return {
    turnStarted(agent, turnId) {
      turnStarts.set(agent.id, { at: Date.now(), turnId });
      step(agent.id, { type: "turn_started" }, 0);
    },
    turnEnded(event, paseo) {
      const start = turnStarts.get(event.agent.id) ?? null;
      turnStarts.delete(event.agent.id);
      const previousEnd = turnEnds.get(event.agent.id) ?? null;
      if (event.timeline) turnEnds.set(event.agent.id, event.timeline.length);
      if (event.outcome.kind === "canceled") {
        step(event.agent.id, { type: "turn_canceled" }, 0);
        log(`skip ${event.agent.id.slice(0, 8)}: turn canceled`);
        return;
      }
      if (event.outcome.kind !== "completed") {
        step(event.agent.id, { type: "turn_canceled" }, 0);
        log(`skip ${event.agent.id.slice(0, 8)}: turn ${event.outcome.kind}`);
        return;
      }
      const startedAtMs = start?.at ?? null;
      // Turn ids are numbered per agent session ("foreground-turn-1", "codex-turn-0"), so they repeat across agents
      // and after a daemon restart; the agent id and start time keep each turn's report and chat row apart.
      const reportId = `turn-report:${event.agent.id}:${event.turnId ?? start?.turnId ?? "turn"}:${startedAtMs ?? Date.now()}`;
      const turn = event.timeline ? sliceTurn(event.timeline, previousEnd) : null;
      const kind = retry.get(event.agent.id)?.kind === "in_followup" ? "plugin_followup" : "turn";
      track(buildReport({ kind, event, reportId, startedAtMs, turn }, paseo).catch((error) => log(`report failed: ${String(error)}`)));
    },
    recent(workspaceId, limit) {
      const out: TurnReport[] = [];
      for (const report of reports) {
        if (out.length >= limit) break;
        if (workspaceId !== null && report.workspaceId !== workspaceId) continue;
        // The daemon validates the RPC output as a whole, so one malformed report would fail the board call.
        const parsed = TurnReportSchema.safeParse(report);
        if (parsed.success) out.push(parsed.data);
        else if (!malformed.has(report.id)) {
          malformed.add(report.id);
          log(`dropping malformed report ${report.id}: ${parsed.error.message.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
      return out;
    },
    rerun(reportId, paseo) {
      const report = reports.find((r) => r.id === reportId);
      if (!report) return { ok: false, error: NOT_FOUND };
      if (!rejudging.has(report.id)) rejudge(report, paseo);
      return { ok: true, error: null };
    },
    async approveCheck(reportId, command, paseo) {
      const report = reports.find((r) => r.id === reportId);
      if (!report) return { ok: false, error: NOT_FOUND };
      // Taken before the first await, so a double click cannot start two runs.
      if (rejudging.has(report.id)) return { ok: true, error: null };
      rejudging.add(report.id);
      let started = false;
      try {
        const check = await resolveCheckCommand(report.cwd, (await readSettings()).checkCommand);
        if (!check || check.source === "setting") return { ok: false, error: check ? "the Check command setting applies to every workspace, nothing to approve" : "this workspace has no paseo.json check" };
        if (check.command !== command) return { ok: false, error: `${check.source} changed since this card: it is now ${check.command}` };
        if (hasHiddenCharacters(command)) return { ok: false, error: "the command has hidden characters (control, zero-width or bidi), shown escaped on the card: fix paseo.json, it cannot be approved" };
        await approvals.approve(report.cwd, command);
        log(`approved ${check.source} for ${report.agentId.slice(0, 8)}'s workspace`);
        rejudge(report, paseo);
        started = true;
        return { ok: true, error: null };
      } finally {
        if (!started) rejudging.delete(report.id);
      }
    },
    async idle() {
      await Promise.all([...inFlight]);
    },
    async dispose() {
      stopping.abort();
      await Promise.race([Promise.all([...inFlight]), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
    },
  };
}
