import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_SETTINGS, type TurnReport, type TurnReportSettings } from "../shared/report";
import { enabledInConfig } from "../server/doc-viewer";
import { createReportService } from "../server/service";
import type { PaseoApi } from "../server/host-types";

const ID = "paseo-doc-viewer";
const viewer = { source: "directory" as const, path: "/plugins/doc-viewer" };

type Config = { pluginsEnabled?: boolean; plugins?: Record<string, { enabled?: boolean; source: "directory"; path: string }> };

async function tempDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tr-dv-")));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakePaseo(config: Config | Error) {
  const appended: TurnReport[] = [];
  const paseo = {
    config: {
      get: async () => {
        if (config instanceof Error) throw config;
        return { requestId: "r", config };
      },
    },
    agents: { ref: () => ({ timeline: { append: async (item: { data: TurnReport }) => void appended.push(item.data) } }) },
  } as unknown as PaseoApi;
  return { paseo, appended };
}

describe("doc viewer state", () => {
  it("counts the viewer enabled only when plugins are on and its entry is not disabled", () => {
    expect(enabledInConfig({ pluginsEnabled: true, plugins: { [ID]: viewer } }, ID)).toBe(true);
    expect(enabledInConfig({ pluginsEnabled: true, plugins: { [ID]: { ...viewer, enabled: false } } }, ID)).toBe(false);
    expect(enabledInConfig({ pluginsEnabled: false, plugins: { [ID]: viewer } }, ID)).toBe(false);
    // The daemon reads an omitted pluginsEnabled as off.
    expect(enabledInConfig({ plugins: { [ID]: viewer } }, ID)).toBe(false);
    expect(enabledInConfig({ pluginsEnabled: true, plugins: {} }, ID)).toBe(false);
    expect(enabledInConfig({ pluginsEnabled: true, plugins: { [ID]: viewer } }, "")).toBe(false);
  });
});

describe("documents and the viewer stamp", () => {
  const baseSettings = { ...DEFAULT_SETTINGS, verify: false, collisions: false };
  const hookAgent = (cwd: string) => ({ id: "A", cwd, title: "A", workspaceId: "w", parentAgentId: null, provider: "mock" });
  const on: Config = { pluginsEnabled: true, plugins: { [ID]: viewer } };
  const everyDocument = [".hidden/x.pdf", "chart.svg", "report.pdf", "vendor/y.pdf"];
  const listed = (report: TurnReport) => report.artifacts.items.map((i) => i.path).sort();

  async function turn(
    config: Config | Error,
    { before, beforeEnd, settings = {} }: { before?: (root: string) => Promise<void>; beforeEnd?: (root: string) => Promise<void>; settings?: Partial<TurnReportSettings> } = {},
  ) {
    const root = await tempDir();
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "vendor"));
    await before?.(root);
    const { paseo, appended } = fakePaseo(config);
    const service = createReportService(async () => ({ ...baseSettings, ...settings }));
    service.turnStarted(hookAgent(root), "t1");
    await new Promise((r) => setTimeout(r, 20));
    for (const path of ["report.pdf", "chart.svg", ".hidden/x.pdf", "vendor/y.pdf"]) await writeFile(join(root, path), "x");
    await beforeEnd?.(root);
    service.turnEnded({ agent: hookAgent(root), turnId: "t1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    return { root, service, paseo, report: appended.at(-1)! };
  }

  async function manyFiles(dir: string, count: number) {
    await mkdir(dir);
    for (let i = 0; i < count; i += 250) await Promise.all(Array.from({ length: Math.min(250, count - i) }, (_, j) => writeFile(join(dir, `f${i + j}.txt`), "")));
  }

  it("lists every document and stamps the report while the viewer is enabled", async () => {
    const { report } = await turn(on);
    expect(listed(report)).toEqual(everyDocument);
    expect(report.artifacts.docViewer).toEqual({ pluginId: ID });
  });

  it("lists every document with no stamp when the viewer is off, disabled, absent or its id is empty", async () => {
    for (const [config, settings] of [
      [{ pluginsEnabled: true, plugins: { [ID]: { ...viewer, enabled: false } } }, {}],
      [{ ...on, pluginsEnabled: false }, {}],
      [{ plugins: on.plugins }, {}],
      [{ pluginsEnabled: true, plugins: {} }, {}],
      [on, { openWithPluginId: "" }],
    ] as const) {
      const { report } = await turn(config, { settings });
      expect(listed(report)).toEqual(everyDocument);
      expect(report.artifacts.docViewer).toBeUndefined();
    }
  });

  it("lists every document with no stamp when the config cannot be read", async () => {
    const { report } = await turn(new Error("host not ready"));
    expect(listed(report)).toEqual(everyDocument);
    expect(report.artifacts.docViewer).toBeUndefined();
  });

  it("lists every document for a viewer with no turn card, as 0.3 and 0.4 have", async () => {
    const { report } = await turn(on);
    expect(listed(report)).toEqual(everyDocument);
  });

  it("lists documents in a folder past the viewer's scan limit", async () => {
    const { report } = await turn(on, {
      before: (root) => manyFiles(join(root, "big"), 5_001),
      beforeEnd: (root) => writeFile(join(root, "big/final.pdf"), "x"),
    });
    expect(listed(report)).toEqual([...everyDocument, "big/final.pdf"].sort());
  });

  it("keeps every document in the stored report when the viewer is disabled later", async () => {
    const config = structuredClone(on);
    const { service, paseo, report } = await turn(config);
    expect(listed(report)).toEqual(everyDocument);
    config.plugins![ID] = { ...viewer, enabled: false };
    service.rerun(report.id, paseo);
    await service.idle();
    const rerun = service.recent(null, 1)[0];
    expect(listed(rerun)).toEqual(everyDocument);
    expect(rerun.artifacts.docViewer).toEqual({ pluginId: ID });
  });

  it("lists a document written just after the turn ends", async () => {
    const { report } = await turn(on, {
      beforeEnd: async (root) => {
        const later = new Date(Date.now() + 600);
        await writeFile(join(root, "late.pdf"), "x");
        await utimes(join(root, "late.pdf"), later, later);
      },
    });
    expect(listed(report)).toEqual([...everyDocument, "late.pdf"].sort());
  });

  it("keeps the turn's answer on Re-run, also after a restart, whatever the viewer is now", async () => {
    const disabled = { pluginsEnabled: true, plugins: { [ID]: { ...viewer, enabled: false } } };
    const stamped = await turn(on);
    const unstamped = await turn({ pluginsEnabled: true, plugins: {} });
    for (const [stored, now, docViewer] of [[stamped.report, disabled, { pluginId: ID }], [unstamped.report, on, undefined]] as const) {
      const { paseo, appended } = fakePaseo(now);
      const restarted = createReportService(async () => baseSettings, { initial: [stored], save: () => {} });
      restarted.rerun(stored.id, paseo);
      await restarted.idle();
      expect(listed(appended.at(-1)!)).toEqual(everyDocument);
      expect(appended.at(-1)!.artifacts.docViewer).toEqual(docViewer);
    }
  });
});
