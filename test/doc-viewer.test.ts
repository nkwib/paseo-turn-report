import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_SETTINGS, type TurnReport } from "../shared/report";
import { createDocViewerProbe, enabledInConfig, paseoHome, turnCardsOn } from "../server/doc-viewer";
import { createReportService } from "../server/service";
import type { PaseoApi } from "../server/host-types";

const ID = "paseo-doc-viewer";
const viewer = { source: "directory" as const, path: "/plugins/doc-viewer" };

async function tempDir() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tr-dv-")));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A daemon home with config.json and, unless null, the viewer's stored settings. */
async function home(values: unknown, version = 1) {
  const dir = await tempDir();
  await writeFile(join(dir, "config.json"), "{}");
  if (values !== null) {
    await mkdir(join(dir, "plugin-settings", ID), { recursive: true });
    await writeFile(join(dir, "plugin-settings", ID, "viewer.json"), typeof values === "string" ? values : JSON.stringify({ version, values }));
  }
  return dir;
}

function fakePaseo(config: { pluginsEnabled?: boolean; plugins?: Record<string, { enabled?: boolean; source: "directory"; path: string }> }, workspaces: Record<string, string>) {
  const appended: TurnReport[] = [];
  const paseo = {
    config: { get: async () => ({ requestId: "r", config }) },
    workspaces: { list: async () => ({ entries: Object.entries(workspaces).map(([id, workspaceDirectory]) => ({ id, workspaceDirectory })) }) },
    agents: {
      list: async () => ({ entries: [] }),
      ref: () => ({ timeline: { append: async (item: { data: TurnReport }) => void appended.push(item.data) } }),
    },
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

  it("resolves the daemon home like the daemon", () => {
    expect(paseoHome({}, "/u")).toBe("/u/.paseo");
    expect(paseoHome({ PASEO_HOME: "~/p" }, "/u")).toBe("/u/p");
    expect(paseoHome({ PASEO_HOME: "/srv/paseo" }, "/u")).toBe("/srv/paseo");
  });

  it("reads turn cards as on only when the stored setting says so or the viewer has none yet", async () => {
    expect(await turnCardsOn(ID, await home(null))).toBe(true);
    expect(await turnCardsOn(ID, await home({ kindColors: false }))).toBe(true);
    expect(await turnCardsOn(ID, await home({ turnCards: true }))).toBe(true);
    expect(await turnCardsOn(ID, await home({ turnCards: false }))).toBe(false);
    expect(await turnCardsOn(ID, await home({ turnCards: true }, 2))).toBe(false);
    expect(await turnCardsOn(ID, await home({ turnCards: "yes" }))).toBe(false);
    expect(await turnCardsOn(ID, await home("{not json"))).toBe(false);
    // No config.json: not the daemon's home, so a missing settings file proves nothing.
    expect(await turnCardsOn(ID, await tempDir())).toBe(false);
  });

  it("finds a card only with the viewer enabled, a workspace and turn cards on", async () => {
    const dir = await tempDir();
    const on = { pluginsEnabled: true, plugins: { [ID]: viewer } };
    const probe = createDocViewerProbe(await home(null));
    const { paseo } = fakePaseo(on, { w: dir });
    expect(await probe.turnStarted(paseo, ID, "w")).toEqual({ pluginId: ID, root: dir });
    expect(await probe.turnStarted(paseo, ID, null)).toBeNull();
    expect(await probe.turnStarted(paseo, ID, "missing")).toBeNull();
    expect(await probe.turnStarted(paseo, "", "w")).toBeNull();
    expect(await probe.turnStarted(fakePaseo({ ...on, pluginsEnabled: false }, { w: dir }).paseo, ID, "w")).toBeNull();
    expect(await probe.turnEnded(paseo, { pluginId: ID, root: dir })).toBe(true);
    expect(await createDocViewerProbe(await home({ turnCards: false })).turnEnded(paseo, { pluginId: ID, root: dir })).toBe(false);
  });
});

describe("documents stamped at turn end", () => {
  const settings = async () => ({ ...DEFAULT_SETTINGS, verify: false, collisions: false });
  const hookAgent = (cwd: string) => ({ id: "A", cwd, title: "A", workspaceId: "w", parentAgentId: null, provider: "mock" });

  async function turn(daemonHome: string, config: Parameters<typeof fakePaseo>[0]) {
    const root = await tempDir();
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "vendor"));
    const { paseo, appended } = fakePaseo(config, { w: root });
    const service = createReportService(settings, undefined, undefined, createDocViewerProbe(daemonHome));
    service.turnStarted(hookAgent(root), "t1", paseo);
    await new Promise((r) => setTimeout(r, 20));
    for (const path of ["report.pdf", "chart.svg", ".hidden/x.pdf", "vendor/y.pdf"]) await writeFile(join(root, path), "x");
    service.turnEnded({ agent: hookAgent(root), turnId: "t1", outcome: { kind: "completed" } }, paseo);
    await service.idle();
    return { root, service, paseo, report: appended.at(-1)! };
  }

  const on = { pluginsEnabled: true, plugins: { [ID]: viewer } };

  it("leaves the viewer's documents to its card and lists the rest", async () => {
    const { root, report } = await turn(await home(null), on);
    expect(report.artifacts.items.map((i) => i.path).sort()).toEqual([".hidden/x.pdf", "chart.svg", "vendor/y.pdf"]);
    expect(report.artifacts.docViewer).toEqual({ pluginId: ID, root, covered: 1 });
  });

  it("lists everything when the viewer's turn cards are off or it is disabled", async () => {
    for (const [daemonHome, config] of [
      [await home({ turnCards: false }), on],
      [await home(null), { ...on, plugins: { [ID]: { ...viewer, enabled: false } } }],
    ] as const) {
      const { report } = await turn(daemonHome, config);
      expect(report.artifacts.items).toHaveLength(4);
      expect(report.artifacts.docViewer).toBeUndefined();
    }
  });

  it("keeps the turn's decision on Re-run", async () => {
    const { service, paseo, report } = await turn(await home(null), on);
    service.rerun(report.id, paseo);
    await service.idle();
    const rerun = service.recent(null, 1)[0];
    expect(rerun.artifacts.items.map((i) => i.path).sort()).toEqual([".hidden/x.pdf", "chart.svg", "vendor/y.pdf"]);
    expect(rerun.artifacts.docViewer?.covered).toBe(1);
  });
});
