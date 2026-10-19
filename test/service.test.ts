import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { BOARD_LIMIT, DEFAULT_SETTINGS, recentReportsRpc, TurnReportSchema, type TurnReport, type TurnReportSettings } from "../shared/report";
import { createReportService } from "../server/service";
import type { AgentTimelineItem, PaseoApi } from "../server/host-types";
import { createCheckApprovals } from "../server/approvals";
import { ensurePrivateDirectory } from "../server/store";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

function fakePaseo(agents: { id: string; cwd: string; title: string }[]) {
  const appended: { agentId: string; data: TurnReport }[] = [];
  const sent: { agentId: string; text: string; behavior: unknown }[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((a) => ({ agent: { ...a, status: "idle", archivedAt: null } })) }),
      ref: (id: string) => ({
        status: "idle",
        refresh: async () => null,
        send: async (text: string, options: { activeTurnBehavior?: unknown }) => void sent.push({ agentId: id, text, behavior: options?.activeTurnBehavior }),
        timeline: { append: async (item: { data: TurnReport }) => (appended.push({ agentId: id, data: item.data }), { seq: appended.length, epoch: "e" }) },
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, appended, sent };
}

const hookAgent = (id: string, cwd: string) => ({ id, cwd, title: id, workspaceId: `ws-${id}`, parentAgentId: null, provider: "mock" });

/** The user approved the paseo.json check `test -f GREEN` for these workspaces. */
async function approvedGreen(...roots: string[]) {
  const approvals = createCheckApprovals(null);
  for (const root of roots) await approvals.approve(root, "test -f GREEN");
  return approvals;
}
const NO_STORE = { initial: [], save: () => {} };

describe("report service", () => {
  let a: string;
  let b: string;
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-svc-"));
    const repo = join(root, "repo");
    sh(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "f.txt"), "one\n");
    await writeFile(join(repo, "paseo.json"), JSON.stringify({ scripts: { test: { command: "test -f GREEN" } } }));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "base");
    a = join(root, "a");
    b = join(root, "b");
    sh(repo, "worktree", "add", "-q", "-b", "a", a);
    sh(repo, "worktree", "add", "-q", "-b", "b", b);
    return () => rm(root, { recursive: true, force: true });
  });

  it("skips canceled turns, reports completed ones, and mirrors conflicts onto the peer's card", async () => {
    const { paseo, appended } = fakePaseo([{ id: "A", cwd: a, title: "A" }, { id: "B", cwd: b, title: "B" }]);
    const service = createReportService(async () => DEFAULT_SETTINGS, NO_STORE, await approvedGreen(a, b));

    service.turnStarted(hookAgent("B", b), "tb1");
    service.turnEnded({ agent: hookAgent("B", b), turnId: "tb1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    expect(service.recent(null, 10)[0]).toMatchObject({ agentId: "B", verify: { state: "failed" }, collisions: { items: [] } });

    service.turnStarted(hookAgent("A", a), "ta0");
    service.turnEnded({ agent: hookAgent("A", a), turnId: "ta0", outcome: { kind: "canceled" } }, paseo);
    await service.idle();
    expect(service.recent(null, 10).map((r) => r.agentId)).toEqual(["B"]);

    await writeFile(join(a, "f.txt"), "from a\n");
    await writeFile(join(b, "f.txt"), "from b\n");
    service.turnStarted(hookAgent("A", a), "ta1");
    service.turnEnded({ agent: hookAgent("A", a), turnId: "ta1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    await new Promise((r) => setTimeout(r, 50));
    const [latestA, latestB] = service.recent(null, 10);
    expect(latestA.collisions.items).toEqual([{ agentId: "B", agentTitle: "B", branch: "b", files: [{ path: "f.txt", kind: "content" }], moreFiles: 0 }]);
    expect(latestB.agentId).toBe("B");
    expect(latestB.collisions.items.map((i) => i.agentId)).toEqual(["A"]);
    // B's card was re-appended under its own id, so the row in B's chat updates in place.
    expect(appended.filter((x) => x.agentId === "B").at(-1)?.data.id).toBe(latestB.id);
  });

  it("keeps one report per agent turn when turn ids repeat across agents and restarts", async () => {
    // Paseo numbers turns per agent session ("foreground-turn-1", "codex-turn-0"), so every agent's first turn shares an id.
    const { paseo, appended } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false }));
    for (const id of ["A", "B"]) {
      service.turnStarted(hookAgent(id, a), "foreground-turn-1");
      service.turnEnded({ agent: hookAgent(id, a), turnId: "foreground-turn-1", outcome: { kind: "completed" } }, paseo);
      await service.idle();
    }
    expect(service.recent(null, 10).map((r) => r.agentId).sort()).toEqual(["A", "B"]);
    // The same agent after a daemon restart numbers its turns from 1 again.
    await new Promise((r) => setTimeout(r, 5));
    service.turnStarted(hookAgent("A", a), "foreground-turn-1");
    service.turnEnded({ agent: hookAgent("A", a), turnId: "foreground-turn-1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    const reports = service.recent(null, 10);
    expect(reports.map((r) => r.agentId)).toEqual(["A", "B", "A"]);
    expect(new Set(reports.map((r) => r.id)).size).toBe(3);
    // Each agent's chat row keeps its own id, so a later card never replaces an earlier one.
    expect(new Set(appended.map((x) => x.data.id)).size).toBe(3);
  });

  it("auto-retry is off by default and opt-in sends the failure with steer, then resets after giving up", async () => {
    const { paseo, sent } = fakePaseo([]);
    const off = createReportService(async () => DEFAULT_SETTINGS, NO_STORE, await approvedGreen(a));
    off.turnStarted(hookAgent("A", a), "x1");
    off.turnEnded({ agent: hookAgent("A", a), turnId: "x1", outcome: { kind: "completed" } }, paseo);
    await off.idle();
    expect(sent).toHaveLength(0);
    expect(off.recent(null, 1)[0].verify).toMatchObject({ state: "failed", attempt: 1, maxAttempts: 1 });

    const settings: TurnReportSettings = { ...DEFAULT_SETTINGS, maxRetries: 1, collisions: false };
    const on = createReportService(async () => settings, NO_STORE, await approvedGreen(a));
    const turn = async (id: string) => {
      on.turnStarted(hookAgent("A", a), id);
      on.turnEnded({ agent: hookAgent("A", a), turnId: id, outcome: { kind: "completed" } }, paseo);
      await on.idle();
      return on.recent(null, 1)[0].verify;
    };
    expect(await turn("y1")).toMatchObject({ state: "retrying", attempt: 1, maxAttempts: 2 });
    expect(sent.at(-1)).toMatchObject({ agentId: "A", behavior: "steer" });
    expect(await turn("y2")).toMatchObject({ state: "gave_up", attempt: 2 });
    expect(sent).toHaveLength(1);
    expect(await turn("y3")).toMatchObject({ state: "retrying", attempt: 1 }); // regression: counter reset
  });

  it("takes changed files from git first: a Codex two-file patch shows one file in the timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-files-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "ws");
    sh(root, "init", "-q", "-b", "main", ws);
    await mkdir(join(ws, "inputs"));
    for (const file of ["make_report.py", "inputs/highlights.md", "notes.txt"]) await writeFile(join(ws, file), "v1\n");
    sh(ws, "add", "-A");
    sh(ws, "commit", "-qm", "base");
    await writeFile(join(ws, "notes.txt"), "edited before the turn\n");
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(join(ws, "notes.txt"), hourAgo, hourAgo);
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false }));
    service.turnStarted(hookAgent("C", ws), "codex-turn-1");
    await writeFile(join(ws, "make_report.py"), "v2\n");
    await writeFile(join(ws, "inputs/highlights.md"), "v2\n");
    const timeline = [
      { type: "user_message" as const, text: "Apply the review notes." },
      { type: "tool_call" as const, callId: "exec-52049fba", name: "apply_patch", status: "completed" as const, error: null, detail: { type: "edit" as const, filePath: "inputs/highlights.md", unifiedDiff: "@@" } },
      { type: "assistant_message" as const, text: "Lightened the header and corrected the Thursday highlight." },
    ];
    service.turnEnded({ agent: hookAgent("C", ws), turnId: "codex-turn-1", outcome: { kind: "completed" }, timeline }, paseo);
    await service.idle();
    expect(service.recent(null, 1)[0].proof?.files).toEqual(["inputs/highlights.md", "make_report.py"]);
  });

  it("adds no card for a chat-only turn, unless the plugin asked for that turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-chat-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "ws");
    sh(root, "init", "-q", "-b", "main", ws);
    await writeFile(join(ws, "paseo.json"), JSON.stringify({ scripts: { test: { command: "test -f GREEN" } } }));
    sh(ws, "add", "-A");
    sh(ws, "commit", "-qm", "base");
    const { paseo, appended, sent } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, maxRetries: 1, collisions: false, artifacts: false }), NO_STORE, await approvedGreen(ws));
    const timeline: AgentTimelineItem[] = [];
    const turn = async (id: string, items: AgentTimelineItem[], during?: () => Promise<void>) => {
      service.turnStarted(hookAgent("D", ws), id);
      await during?.();
      timeline.push(...items);
      service.turnEnded({ agent: hookAgent("D", ws), turnId: id, outcome: { kind: "completed" }, timeline: [...timeline] }, paseo);
      await service.idle();
      return appended.filter((x) => x.data.turnId === id).at(-1)?.data;
    };
    const chat = (question: string, answer: string): AgentTimelineItem[] => [
      { type: "user_message", text: question, messageId: question },
      { type: "assistant_message", text: answer },
    ];

    expect(await turn("t1", chat("What does add do?", "It returns the sum of its two arguments."))).toBeUndefined();
    expect(service.recent(null, 10)).toEqual([]);
    expect(await turn("t2", chat("Note the edge case in the README.", "Done."))).toMatchObject({ verify: { state: "retrying" } });
    expect(sent).toHaveLength(1);
    expect(await turn("t3", chat(sent[0]!.text, "I can't make the check pass: GREEN is a marker only you can create."))).toMatchObject({ verify: { state: "gave_up" } });
    expect(await turn("t4", chat("Ok, thanks.", "You're welcome."))).toBeUndefined();
    expect(await turn("t5", chat("Anything else?", "No."), () => writeFile(join(ws, "notes.md"), "x\n"))).toMatchObject({ proof: { files: ["notes.md"] } });
  });

  it("re-run keeps the files judged at the time and always republishes the card", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-rerun-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "ws");
    sh(root, "init", "-q", "-b", "main", ws);
    await writeFile(join(ws, "f.txt"), "v1\n");
    sh(ws, "add", "-A");
    sh(ws, "commit", "-qm", "base");
    const settings = async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false });
    const { paseo, appended } = fakePaseo([]);
    const service = createReportService(settings);
    service.turnStarted(hookAgent("E", ws), "e1");
    await writeFile(join(ws, "notes.md"), "x\n");
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Write the notes.", messageId: "m1" },
      { type: "assistant_message", text: "Wrote notes.md." },
    ];
    service.turnEnded({ agent: hookAgent("E", ws), turnId: "e1", outcome: { kind: "completed" }, timeline }, paseo);
    await service.idle();
    const report = service.recent(null, 1)[0]!;
    expect(report.proof?.files).toEqual(["notes.md"]);

    await writeFile(join(ws, "later.md"), "written after the turn\n");
    appended.length = 0;
    expect(service.rerun(report.id, paseo)).toEqual({ ok: true, error: null });
    await service.idle();
    expect(appended.at(-1)?.data).toMatchObject({ id: report.id, proof: { files: ["notes.md"] } });

    const chatOnly: TurnReport = { ...report, proof: { ...report.proof!, files: [], testFiles: [] } };
    const restored = createReportService(settings, { initial: [chatOnly], save: () => {} });
    appended.length = 0;
    expect(restored.rerun(report.id, paseo)).toEqual({ ok: true, error: null });
    await restored.idle();
    expect(appended.at(-1)?.data).toMatchObject({ id: report.id, proof: { commandsTotal: 0, claims: [], files: [] } });
  });

  it("re-run scans documents in the original turn window, not until now", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-rerun-window-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "ws");
    sh(root, "init", "-q", "-b", "main", ws);
    await writeFile(join(ws, "f.txt"), "v1\n");
    sh(ws, "add", "-A");
    sh(ws, "commit", "-qm", "base");
    const now = Date.now();
    const at = (ms: number) => new Date(ms);
    await writeFile(join(ws, "report.pdf"), "in the turn");
    await utimes(join(ws, "report.pdf"), at(now - 55_000), at(now - 55_000));
    await writeFile(join(ws, "later.csv"), "a,b\n");
    await utimes(join(ws, "later.csv"), at(now - 10_000), at(now - 10_000));
    const turn: TurnReport = {
      id: "turn-report:W:w1:1", agentId: "W", agentTitle: "W", workspaceId: "ws-W", turnId: "w1", cwd: ws, branch: "main",
      startedAt: at(now - 60_000).toISOString(), endedAt: at(now - 50_000).toISOString(),
      verify: { state: "skipped", command: null, exitCode: null, durationMs: 0, tail: "", attempt: 0, maxAttempts: 1, note: null },
      collisions: { state: "skipped", peersChecked: 0, items: [], durationMs: 0, note: null },
      artifacts: { state: "done", items: [], more: 0, note: null },
      proof: null,
    };
    const settings = async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false });
    const { paseo, appended } = fakePaseo([]);
    const service = createReportService(settings, { initial: [turn], save: () => {} });

    expect(service.rerun(turn.id, paseo)).toEqual({ ok: true, error: null });
    await service.idle();
    const rerun = appended.at(-1)!.data;
    expect(rerun.artifacts.items.map((item) => item.path)).toEqual(["report.pdf"]);
    expect(rerun.endedAt).toBe(turn.endedAt);
  });

  it("a turn with a malformed tool call still gets its card", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-bad-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false }), NO_STORE);
    const timeline = [
      { type: "user_message", text: "go", messageId: "u" },
      { type: "tool_call", callId: "x", name: "Bash", status: "completed", error: null },
      { type: "tool_call", callId: "y", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test", exitCode: 0 } },
      { type: "assistant_message", text: "All tests pass." },
    ] as unknown as AgentTimelineItem[];
    service.turnStarted(hookAgent("M", root), "m1");
    service.turnEnded({ agent: hookAgent("M", root), turnId: "m1", outcome: { kind: "completed" }, timeline }, paseo);
    await service.idle();
    expect(service.recent(null, 1)[0]?.proof?.claims.map((c) => [c.kind, c.verdict])).toEqual([["tests_pass", "verified"]]);
  });

  it("with no check command, points at the Check command setting and paseo.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-nocheck-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, collisions: false, artifacts: false }), NO_STORE);
    service.turnStarted(hookAgent("N", root), "n1");
    service.turnEnded({ agent: hookAgent("N", root), turnId: "n1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    expect(service.recent(null, 1)[0]?.verify).toMatchObject({ state: "skipped", note: "no check command: set Check command in the Turn report settings, or add scripts.verify, scripts.check or scripts.test to paseo.json" });
  });

  it("runs no check on Windows and says checks need macOS or Linux (review S9)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-win-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    onTestFinished(() => void Object.defineProperty(process, "platform", platform));
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, checkCommand: "touch RAN", collisions: false, artifacts: false }), NO_STORE);
    service.turnStarted(hookAgent("W", root), "w1");
    service.turnEnded({ agent: hookAgent("W", root), turnId: "w1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    expect(service.recent(null, 1)[0]?.verify).toMatchObject({ state: "skipped", command: null, note: "checks need macOS or Linux" });
    expect(await access(join(root, "RAN")).then(() => true, () => false)).toBe(false);
  });

  it("refuses to approve a paseo.json command with control, zero-width or bidi characters", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-hidden-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const store = join(root, "store");
    await ensurePrivateDirectory(store);
    const ws = join(root, "ws");
    await mkdir(ws);
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, collisions: false, artifacts: false }), NO_STORE, createCheckApprovals(store));
    for (const [i, command] of ["npm test\u001b[8m; touch RAN", "npm\u200b test; touch RAN", "npm test #\u202e; touch RAN"].entries()) {
      await writeFile(join(ws, "paseo.json"), JSON.stringify({ scripts: { test: { command } } }));
      service.turnStarted(hookAgent("H", ws), `h${i}`);
      service.turnEnded({ agent: hookAgent("H", ws), turnId: `h${i}`, outcome: { kind: "completed" } }, paseo);
      await service.idle();
      const report = service.recent(null, 1)[0]!;
      expect(report.verify).toMatchObject({ state: "needs_approval", command });
      expect(await service.approveCheck(report.id, command, paseo)).toEqual({ ok: false, error: "the command has hidden characters (control, zero-width or bidi), shown escaped on the card: fix paseo.json, it cannot be approved" });
      await service.idle();
      expect(await access(join(ws, "RAN")).then(() => true, () => false)).toBe(false);
    }
  });

  it("approving twice while that report's check runs starts one run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-twice-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const store = join(root, "store");
    await ensurePrivateDirectory(store);
    const ws = join(root, "ws");
    await mkdir(ws);
    const command = "echo run >> RUNS; sleep 0.3";
    await writeFile(join(ws, "paseo.json"), JSON.stringify({ scripts: { test: { command } } }));
    const { paseo, appended } = fakePaseo([]);
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, collisions: false, artifacts: false }), NO_STORE, createCheckApprovals(store));
    service.turnStarted(hookAgent("T", ws), "t1");
    service.turnEnded({ agent: hookAgent("T", ws), turnId: "t1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    const report = service.recent(null, 1)[0]!;
    expect(report.verify.state).toBe("needs_approval");
    const before = appended.length;

    const results = await Promise.all([service.approveCheck(report.id, command, paseo), service.approveCheck(report.id, command, paseo)]);
    const third = await service.approveCheck(report.id, command, paseo);
    await service.idle();
    expect([...results, third]).toEqual([{ ok: true, error: null }, { ok: true, error: null }, { ok: true, error: null }]);
    expect((await readFile(join(ws, "RUNS"), "utf8")).trim().split("\n")).toEqual(["run"]);
    // One re-judge of the card: no "a check is already running" state from a second one.
    expect(appended.slice(before).filter((x) => x.data.id === report.id).map((x) => x.data.verify.state)).toEqual(["running", "running", "passed"]);
  });

  it("runs a paseo.json check only after the user approves that exact command for the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-appr-svc-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const ws = join(root, "ws");
    const store = join(root, "store");
    await ensurePrivateDirectory(store);
    sh(root, "init", "-q", "-b", "main", ws);
    const command = "touch RAN && test -f GREEN";
    const setCheck = (cmd: string) => writeFile(join(ws, "paseo.json"), JSON.stringify({ scripts: { test: { command: cmd } } }));
    await setCheck(command);
    sh(ws, "add", "-A");
    sh(ws, "commit", "-qm", "base");
    const ran = () => access(join(ws, "RAN")).then(() => true, () => false);
    let settings: TurnReportSettings = { ...DEFAULT_SETTINGS, collisions: false, artifacts: false };
    const { paseo } = fakePaseo([]);
    const service = createReportService(async () => settings, NO_STORE, createCheckApprovals(store));
    const turn = async (id: string) => {
      service.turnStarted(hookAgent("F", ws), id);
      service.turnEnded({ agent: hookAgent("F", ws), turnId: id, outcome: { kind: "completed" } }, paseo);
      await service.idle();
      return service.recent(null, 1)[0]!;
    };

    const first = await turn("f1");
    expect(first.verify).toMatchObject({ state: "needs_approval", command, exitCode: null });
    expect(await ran()).toBe(false);
    expect(await service.approveCheck(first.id, "true", paseo)).toMatchObject({ ok: false });
    expect(await turn("f2")).toMatchObject({ verify: { state: "needs_approval" } });
    expect(await ran()).toBe(false);

    expect(await service.approveCheck(first.id, command, paseo)).toEqual({ ok: true, error: null });
    await service.idle();
    expect(await ran()).toBe(true);
    expect(service.recent(null, 10).find((r) => r.id === first.id)?.verify).toMatchObject({ state: "failed", command, exitCode: 1 });
    expect(await turn("f3")).toMatchObject({ verify: { state: "failed", command } });

    await rm(join(ws, "RAN"));
    await setCheck("touch RAN && true");
    expect(await turn("f4")).toMatchObject({ verify: { state: "needs_approval", command: "touch RAN && true" } });
    expect(await ran()).toBe(false);

    await setCheck(command);
    const restarted = createReportService(async () => settings, NO_STORE, createCheckApprovals(store));
    restarted.turnStarted(hookAgent("F", ws), "f5");
    restarted.turnEnded({ agent: hookAgent("F", ws), turnId: "f5", outcome: { kind: "completed" } }, paseo);
    await restarted.idle();
    expect(restarted.recent(null, 1)[0]?.verify).toMatchObject({ state: "failed", command });

    await rm(join(ws, "RAN"));
    settings = { ...settings, checkCommand: "touch RAN" };
    expect(await turn("f6")).toMatchObject({ verify: { state: "passed", command: "touch RAN", note: "setting" } });
    expect(await ran()).toBe(true);
  });

  it("proof: slices each turn from the hook timeline and re-judges claims after the plugin check", async () => {
    const { paseo, appended } = fakePaseo([]);
    // A test script that is not there: a failing check the claim's kind accepts (`test -f GREEN` runs no tests).
    const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, checkCommand: "sh ./test.sh", collisions: false, artifacts: false }), NO_STORE);
    const turn1 = [
      { type: "user_message" as const, text: "first" },
      { type: "tool_call" as const, callId: "c1", name: "Bash", status: "completed" as const, error: null, detail: { type: "shell" as const, command: "npm test", exitCode: 0 } },
      { type: "assistant_message" as const, text: "All tests pass." },
    ];
    service.turnStarted(hookAgent("A", a), "p1");
    service.turnEnded({ agent: hookAgent("A", a), turnId: "p1", outcome: { kind: "completed" }, timeline: turn1 }, paseo);
    await service.idle();
    const proof1 = service.recent(null, 1)[0].proof;
    expect(proof1).toMatchObject({ check: { command: "sh ./test.sh", agentRan: null, pluginPassed: false } });
    expect(proof1?.claims.map((c) => [c.kind, c.verdict])).toEqual([["tests_pass", "mismatch"]]);
    expect(TurnReportSchema.parse(service.recent(null, 1)[0]).proof).toEqual(proof1);
    // The first append carries the proof before the check finished.
    expect(appended.find((x) => x.data.turnId === "p1")?.data.proof?.check.pluginPassed).toBeNull();

    const turn2 = [...turn1, { type: "user_message" as const, text: "second" }, { type: "assistant_message" as const, text: "Done." }];
    service.turnStarted(hookAgent("A", a), "p2");
    service.turnEnded({ agent: hookAgent("A", a), turnId: "p2", outcome: { kind: "completed" }, timeline: turn2 }, paseo);
    await service.idle();
    const proof2 = service.recent(null, 1)[0].proof;
    expect(proof2?.commandsTotal).toBe(0);
    expect(proof2?.claims.map((c) => [c.kind, c.verdict])).toEqual([["done", "check_failed"]]);
  });
});

describe("stored reports", () => {
  const stored = (id: string, durationMs: number): TurnReport => ({
    id, agentId: "a", agentTitle: "a", workspaceId: "w", turnId: id, cwd: "/r", branch: "main", startedAt: null, endedAt: "2026-10-17T22:00:00.000Z",
    verify: { state: "passed", command: "npm test", exitCode: 0, durationMs, tail: "", attempt: 1, maxAttempts: 1, note: null },
    collisions: { state: "done", peersChecked: 0, items: [], durationMs: 5, note: null },
    artifacts: { state: "done", items: [], more: 0, note: null },
    proof: null,
  });

  it("says a missing report is no longer kept, not that reports live in memory", async () => {
    const service = createReportService(async () => DEFAULT_SETTINGS);
    const { paseo } = fakePaseo([]);
    const missing = { ok: false, error: "report not found: the plugin keeps the last 200 reports" };
    expect(service.rerun("gone", paseo)).toEqual(missing);
    expect(await service.approveCheck("gone", "npm test", paseo)).toEqual(missing);
  });

  it("the board can fetch every kept report", () => {
    const kept = Array.from({ length: 250 }, (_, i) => stored(`k${i}`, 10));
    const service = createReportService(async () => DEFAULT_SETTINGS, { initial: kept, save: () => {} });
    expect(recentReportsRpc.input.safeParse({ workspaceId: null, limit: 200 }).success).toBe(true);
    const input = recentReportsRpc.input.parse({ workspaceId: null, limit: BOARD_LIMIT });
    expect(service.recent(input.workspaceId, input.limit)).toHaveLength(200);
  });

  it("drops a malformed report instead of failing the whole call, and logs it once", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    // NaN type-checks as a number but fails the RPC's output schema, which the daemon validates as a whole.
    const service = createReportService(async () => DEFAULT_SETTINGS, { initial: [stored("t2", 10), stored("t1", Number.NaN), stored("t0", 10)], save: () => {} });

    const first = service.recent(null, 10);
    expect(first.map((r) => r.id)).toEqual(["t2", "t0"]);
    expect(() => TurnReportSchema.array().parse(first)).not.toThrow();
    expect(service.recent(null, 10).map((r) => r.id)).toEqual(["t2", "t0"]);
    expect(service.recent(null, 1).map((r) => r.id)).toEqual(["t2"]);
    expect(logged.mock.calls.filter(([line]) => String(line).includes("malformed report t1"))).toHaveLength(1);
  });
});
