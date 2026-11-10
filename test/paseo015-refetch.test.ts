import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createReportService, MAX_TIMELINE_PAGES, TIMELINE_PAGE } from "../server/service";
import { sliceFetchedTurn, type FetchedTimelineEntry } from "../server/proof";
import { DEFAULT_SETTINGS, type TurnReport } from "../shared/report";
import type { AgentTimelineItem, PaseoApi } from "../server/host-types";

interface Page { entries: FetchedTimelineEntry[]; hasOlder?: boolean; startCursor?: { epoch: string; seq: number } | null }
type Refetch = (options: Record<string, unknown>) => Promise<Page>;

/** Paseo 0.15: turn hooks send `timeline: []`, the plugin reads the rows through `timeline.refetch`. */
async function paseo015(refetch: Refetch) {
  const cwd = await mkdtemp(join(tmpdir(), "turn-report-015-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(cwd, name), `${name}\n`);
  const agent = { id: "dsh-agent-test", cwd, title: "DSH writer", workspaceId: "workspace-test", parentAgentId: null, provider: "deepseek-harness-native" };
  const calls: Record<string, unknown>[] = [];
  const published: TurnReport[] = [];
  const paseo = {
    config: { get: async () => ({ config: {} }) },
    agents: {
      ref: () => ({
        timeline: {
          refetch: (options: Record<string, unknown>) => (calls.push(options), refetch(options)),
          append: async (event: { data: TurnReport }) => (published.push(event.data), { epoch: "test", seq: published.length }),
        },
      }),
    },
  } as unknown as PaseoApi;
  const service = createReportService(async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false }), { initial: [], save: () => {} });
  const runTurn = async (turnId: string, during: () => void = () => {}, timeline: AgentTimelineItem[] = []) => {
    service.turnStarted(agent, turnId);
    during();
    service.turnEnded({ agent, turnId, outcome: { kind: "completed" }, timeline }, paseo);
    await service.idle();
  };
  const write = (name: string): AgentTimelineItem => ({ type: "tool_call", callId: name, name: "write", status: "completed", error: null, detail: { type: "write", filePath: join(cwd, name) } });
  return { cwd, service, calls, published, runTurn, write };
}

const row = (item: AgentTimelineItem, at = Date.now(), turnId?: string): FetchedTimelineEntry => ({ item, timestamp: new Date(at).toISOString(), ...(turnId ? { turnId } : {}) });
const say = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });
const ask = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const names = (report: TurnReport | undefined) => report?.proof?.files.map((file) => file.split("/").pop()) ?? null;

describe("Paseo 0.15 turn hooks without a timeline", () => {
  it("fetches the projected tail and reports the turn's write", async () => {
    const rows: FetchedTimelineEntry[] = [];
    const t = await paseo015(async () => ({ entries: rows }));
    await t.runTurn("dsh-turn-1", () => rows.push(row(ask("Create a note")), row(t.write("a.md")), row(say("Created the note"))));
    expect(t.calls).toEqual([{ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" }]);
    expect(t.published.length).toBeGreaterThan(0);
    expect(names(t.service.recent(null, 1)[0])).toEqual(["a.md"]);
  });

  it("a turn without a user message takes in no earlier turn's work", async () => {
    const rows: FetchedTimelineEntry[] = [];
    const t = await paseo015(async () => ({ entries: rows }));
    rows.push(row(ask("write a"), Date.now() - 5000), row(t.write("a.md"), Date.now() - 4000), row(say("done"), Date.now() - 3000));
    // A finished background task starts the turn: no prompt, one write.
    await t.runTurn("dsh-turn-2", () => rows.push(row(t.write("b.md")), row(say("background task done"))));
    expect(names(t.service.recent(null, 1)[0])).toEqual(["b.md"]);
  });

  it("a prompt sent before the fetch returns neither hides the turn's tools nor adds its own", async () => {
    const rows: FetchedTimelineEntry[] = [];
    const t = await paseo015(async () => {
      // The next turn started while the fetch was in flight.
      rows.push(row(ask("next"), Date.now() + 1000, "dsh-turn-2"), row(t.write("c.md"), Date.now() + 2000, "dsh-turn-2"));
      return { entries: rows };
    });
    await t.runTurn("dsh-turn-1", () => rows.push(row(ask("write a"), Date.now(), "dsh-turn-1"), row(t.write("a.md"), Date.now(), "dsh-turn-1")));
    expect(names(t.service.recent(null, 1)[0])).toEqual(["a.md"]);
  });

  it("pages back until it reaches the start of a turn longer than one page", async () => {
    let older: FetchedTimelineEntry[] = [];
    let tail: FetchedTimelineEntry[] = [];
    const t = await paseo015(async (options) =>
      options.direction === "tail" ? { entries: tail, hasOlder: true, startCursor: { epoch: "e", seq: 500 } } : { entries: older, hasOlder: true, startCursor: { epoch: "e", seq: 1 } },
    );
    await t.runTurn("dsh-turn-1", () => {
      older = [row(say("earlier turn"), Date.now() - 5000), row(ask("long job")), row(t.write("a.md"))];
      tail = [row(t.write("b.md")), row(say("done"))];
    });
    expect(t.calls.map((call) => call.direction)).toEqual(["tail", "before"]);
    expect(t.calls[1]).toMatchObject({ cursor: { epoch: "e", seq: 500 }, limit: TIMELINE_PAGE, projection: "projected" });
    expect(names(t.service.recent(null, 1)[0])?.sort()).toEqual(["a.md", "b.md"]);
  });

  it("stops paging after MAX_TIMELINE_PAGES and logs that the turn's earliest rows are left out", async () => {
    const logs = vi.spyOn(console, "log");
    onTestFinished(() => logs.mockRestore());
    let rows: FetchedTimelineEntry[] = [];
    const t = await paseo015(async () => ({ entries: rows, hasOlder: true, startCursor: { epoch: "e", seq: 1 } }));
    await t.runTurn("dsh-turn-1", () => (rows = [row(t.write("a.md"))]));
    expect(t.calls).toHaveLength(MAX_TIMELINE_PAGES);
    expect(logs.mock.calls.some(([line]) => String(line).includes("earliest rows are left out"))).toBe(true);
    expect(names(t.service.recent(null, 1)[0])).toEqual(["a.md"]);
  });

  it("a failed fetch publishes the card without proof instead of skipping it as chat-only", async () => {
    const t = await paseo015(async () => {
      throw new Error("daemon unreachable");
    });
    await t.runTurn("dsh-turn-1");
    expect(t.calls).toHaveLength(1);
    expect(t.service.recent(null, 1)).toHaveLength(1);
    expect(t.service.recent(null, 1)[0].proof).toBeNull();
  });

  it("a hook that sends the timeline is never refetched", async () => {
    const t = await paseo015(async () => ({ entries: [] }));
    await t.runTurn("turn-1", () => {}, [ask("write a"), t.write("a.md")]);
    expect(t.calls).toHaveLength(0);
    expect(names(t.service.recent(null, 1)[0])).toEqual(["a.md"]);
  });
});

describe("sliceFetchedTurn", () => {
  const at = 1_000_000;
  const entries = [row(ask("one"), at - 10), row(say("a"), at - 5), row(say("b"), at + 1, "t2"), row(say("c"), at + 2, "t9"), row(say("d"), at + 3), row(ask("later"), at + 50)];

  it("keeps the turn's window, drops rows after its end and rows of another turn id", () => {
    const { timeline, turn } = sliceFetchedTurn(entries, { startedAtMs: at, endedAtMs: at + 10 }, "t2");
    expect(turn).toEqual([say("b"), say("d")]);
    expect(timeline).toEqual([ask("one"), say("a"), say("b"), say("d")]);
  });

  it("without a known start, falls back to the last user message before the end", () => {
    expect(sliceFetchedTurn(entries, { startedAtMs: null, endedAtMs: at + 10 }, null).turn).toEqual([ask("one"), say("a"), say("b"), say("c"), say("d")]);
  });
});
