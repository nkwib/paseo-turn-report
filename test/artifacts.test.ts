import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { ARTIFACT_KINDS, artifactKind, collectArtifacts, DOC_VIEWER_EXTENSIONS, docViewerLists, selectArtifacts, type FileStat } from "../server/artifacts";

// The doc viewer's kinds.ts, when a checkout is at hand: DOC_VIEWER_SOURCE, or ../paseo-doc-viewer next to this one.
const DOC_VIEWER_KINDS = [process.env.DOC_VIEWER_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../paseo-doc-viewer")]
  .map((dir) => join(dir, "shared/kinds.ts"))
  .find((path) => existsSync(path));

const T0 = 1_760_000_000_000;
const file = (path: string, mtimeOffset: number, birthOffset = -86_400_000, size = 10): FileStat => ({ path, mtimeMs: T0 + mtimeOffset, birthtimeMs: T0 + birthOffset, size });

describe("selectArtifacts", () => {
  const window = { startedAtMs: T0, endedAtMs: T0 + 60_000 };

  it("keeps supported documents modified inside the turn window, newest first", () => {
    const { items, more } = selectArtifacts(
      [file("out/report.pdf", 30_000, 29_000), file("data/results.csv", 50_000), file("src/app.ts", 40_000), file("old.pdf", -600_000), file("later.xlsx", 3_600_000)],
      window,
    );
    expect(items).toEqual([
      { path: "data/results.csv", kind: "csv", size: 10, status: "changed" },
      { path: "out/report.pdf", kind: "pdf", size: 10, status: "new" },
    ]);
    expect(more).toBe(0);
  });

  it("allows clock and mtime slack at both edges", () => {
    const { items } = selectArtifacts([file("a.png", -1_000), file("b.png", 61_000), file("c.png", -5_000)], window);
    expect(items.map((i) => i.path)).toEqual(["b.png", "a.png"]);
  });

  it("caps the list and reports the rest", () => {
    const many = Array.from({ length: 15 }, (_, i) => file(`f${i}.jsonl`, i * 1000));
    const { items, more } = selectArtifacts(many, window, undefined, 12);
    expect(items).toHaveLength(12);
    expect(more).toBe(3);
    expect(items[0].path).toBe("f14.jsonl");
  });

  it("treats birthtime 0 as unknown (changed)", () => {
    expect(selectArtifacts([file("x.docx", 1000, -T0)], window).items[0].status).toBe("changed");
  });

  it("maps extensions case-insensitively", () => {
    expect(artifactKind("A/B/Deck.PPTX")).toBe("pptx");
    expect(artifactKind("nb.ipynb")).toBe("ipynb");
    expect(artifactKind("pic.JPEG")).toBe("image");
    expect(artifactKind("main.rs")).toBeNull();
  });

  it("lists what the doc viewer opens (0.5.2 shared/kinds.ts), plus SVG and notebooks", () => {
    const docViewer = ["pdf", "docx", "xlsx", "csv", "tsv", "jsonl", "ndjson", "parquet", "pptx", "mp4", "m4v", "mov", "webm", "mp3", "m4a", "wav", "flac", "png", "jpg", "jpeg", "gif", "tif", "tiff", "heic", "heif", "webp"];
    expect([...DOC_VIEWER_EXTENSIONS].sort()).toEqual(docViewer.sort());
    expect(Object.keys(ARTIFACT_KINDS).sort()).toEqual([...docViewer, "svg", "ipynb"].sort());
    expect([artifactKind("runs.tsv"), artifactKind("log.ndjson"), artifactKind("t.parquet"), artifactKind("demo.MOV"), artifactKind("a.flac"), artifactKind("p.HEIC")]).toEqual(["csv", "jsonl", "parquet", "video", "audio", "image"]);
  });

  it.skipIf(!DOC_VIEWER_KINDS)("matches the doc viewer checkout's kinds.ts", async () => {
    const { DOCUMENT_KINDS, KIND_REGISTRY } = await import(DOC_VIEWER_KINDS!);
    const extensions = (DOCUMENT_KINDS as string[]).flatMap((kind) => KIND_REGISTRY[kind].extensions as string[]);
    expect([...DOC_VIEWER_EXTENSIONS].sort()).toEqual(extensions.sort());
  });

  it("counts covered documents apart and caps only the rest", () => {
    const many = Array.from({ length: 14 }, (_, i) => file(`f${i}.pdf`, i * 1000));
    const { items, more, covered } = selectArtifacts([...many, file("chart.svg", 0)], window, (f) => f.path.endsWith(".pdf"));
    expect(items.map((i) => i.path)).toEqual(["chart.svg"]);
    expect([more, covered]).toEqual([0, 14]);
  });
});

describe("docViewerLists", () => {
  it("covers the types the viewer opens, wherever its scan reaches", () => {
    for (const path of ["report.pdf", "out/Deck.PPTX", "a/b/c/data.tsv", "~notes.pdf", ".hidden.pdf", `${"d/".repeat(16)}deep.pdf`]) expect(docViewerLists(path)).toBe(true);
  });

  it("leaves SVG, notebooks and what the viewer's scan skips to this card", () => {
    for (const path of [
      "chart.svg",
      "nb.ipynb",
      ".hidden/x.pdf",
      "docs/.cache/x.pdf",
      "vendor/y.pdf",
      "a/node_modules/x.pdf",
      "target/x.pdf",
      "venv/x.pdf",
      "~$draft.docx",
      "._report.pdf",
      `${"d/".repeat(17)}deep.pdf`,
      "../outside.pdf",
      "/abs/x.pdf",
      ".pdf",
      "README",
    ])
      expect(docViewerLists(path), path).toBe(false);
  });
});

describe("collectArtifacts", () => {
  it("scans a real tree, skipping node_modules and .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "tr-art-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "out"));
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await mkdir(join(root, ".git"));
    const started = Date.now();
    await writeFile(join(root, "out/report.pdf"), "%PDF-1.4");
    await writeFile(join(root, "node_modules/pkg/readme.pdf"), "x");
    await writeFile(join(root, ".git/x.csv"), "x");
    await writeFile(join(root, "stale.csv"), "x");
    const old = new Date(started - 3_600_000);
    await utimes(join(root, "stale.csv"), old, old);
    const report = await collectArtifacts(root, { startedAtMs: started, endedAtMs: Date.now() });
    expect(report.items.map((i) => i.path)).toEqual(["out/report.pdf"]);
    expect(report.state).toBe("done");
  });

  it("leaves to the viewer card the documents its scan reaches inside its workspace, written since the turn start", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "tr-art-")));
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, "repo");
    await mkdir(join(root, "app/.hidden"), { recursive: true });
    await mkdir(join(root, "app/vendor"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    const started = Date.now();
    for (const path of ["app/a.pdf", "app/chart.svg", "app/.hidden/x.pdf", "app/vendor/y.pdf", "other/b.pdf", "app/early.pdf"]) await writeFile(join(root, path), "x");
    const early = new Date(started - 1_000);
    await utimes(join(root, "app/early.pdf"), early, early);
    const report = await collectArtifacts(root, { startedAtMs: started, endedAtMs: Date.now() + 10 }, { pluginId: "paseo-doc-viewer", root: join(root, "app") });
    expect(report.items.map((i) => i.path).sort()).toEqual(["app/.hidden/x.pdf", "app/chart.svg", "app/early.pdf", "app/vendor/y.pdf", "other/b.pdf"]);
    expect(report.docViewer).toEqual({ pluginId: "paseo-doc-viewer", root: join(root, "app"), covered: 1 });
    expect((await collectArtifacts(root, { startedAtMs: started, endedAtMs: Date.now() + 10 })).docViewer).toBeUndefined();
  });

  it("skips when the turn start was not observed", async () => {
    expect((await collectArtifacts("/nonexistent", null)).state).toBe("skipped");
  });
});
