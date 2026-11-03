import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createReportService } from "../server/service";
import { DEFAULT_SETTINGS, type TurnReport } from "../shared/report";
import type { AgentTimelineItem, PaseoApi } from "../server/host-types";

it("Paseo 0.15 empty turn-ended timeline retrieves the writing turn before judging it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "turn-report-015-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const filePath = join(cwd, "notes.md");
  await writeFile(filePath, "real file\n");
  const agent = { id: "dsh-agent-test", cwd, title: "DSH writer",
    workspaceId: "workspace-test", parentAgentId: null, provider: "deepseek-harness-native" };
  const events: AgentTimelineItem[] = [
    { type: "user_message", text: "Create a note" },
    { type: "tool_call", callId: "write-1", name: "write",
      status: "completed", error: null, detail: { type: "write", filePath } },
    { type: "assistant_message", text: "Created the note" },
  ];
  let refetches = 0;
  const published: TurnReport[] = [];
  const paseo = {
    config: { get: async () => ({ config: {} }) },
    agents: {
      ref: () => ({ timeline: {
        refetch: async () => { refetches++; return { entries: events.map((item) => ({ item })) }; },
        append: async (event: { data: TurnReport }) => {
          published.push(event.data); return { epoch: "test", seq: published.length };
        },
      } }),
    },
  } as unknown as PaseoApi;
  const service = createReportService(
    async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false, artifacts: false }),
    { initial: [], save: () => {} },
  );
  service.turnStarted(agent, "dsh-turn-1");
  service.turnEnded({ agent, turnId: "dsh-turn-1", outcome: { kind: "completed" }, timeline: [] }, paseo);
  await service.idle();
  expect(refetches).toBe(1);
  expect(published.length).toBeGreaterThan(0);
  expect(service.recent(null, 1)[0].proof?.files.some((file) => file === "notes.md" || file.endsWith("/notes.md"))).toBe(true);
});