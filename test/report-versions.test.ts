import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { REPORT_SCHEMAS, REPORT_VERSION, type TurnReport } from "../shared/report";
import { createSaver, loadReports } from "../server/store";

const card: TurnReport = {
  id: "r1",
  agentId: "a",
  agentTitle: "a",
  workspaceId: "w",
  turnId: "t1",
  cwd: "/r",
  branch: "main",
  startedAt: null,
  endedAt: "2026-10-17T22:00:00.000Z",
  verify: { state: "passed", command: "npm test", exitCode: 0, durationMs: 10, tail: "", attempt: 1, maxAttempts: 1, note: null },
  collisions: { state: "done", peersChecked: 0, items: [], durationMs: 5, note: null },
  artifacts: { state: "done", items: [], more: 0, note: null },
  proof: {
    provider: "claude",
    commands: [{ command: "npm test", kind: "test", exitCode: 0, outcome: "ok", index: 2 }],
    commandsTotal: 1,
    failedTools: [],
    deniedTools: [],
    files: ["src/add.ts"],
    testFiles: [],
    lastEditIndex: 1,
    check: { command: "npm test", agentRan: { exitCode: 0, outcome: "ok" }, pluginPassed: true },
    claims: [{ kind: "tests_pass", text: "All tests pass.", verdict: "verified", reason: "npm test passed" }],
    rules: 2,
  },
};

const mainEraProof = {
  provider: "claude",
  commands: [{ command: "npm test", kind: "test", exitCode: 1, ok: false, index: 2 }],
  commandsTotal: 1,
  failedTools: [],
  files: [],
  testFiles: [],
  check: { command: null, agentRan: null, pluginPassed: false },
  claims: [{ kind: "fixed", text: "Fixed the add bug.", verdict: "contradicted", reason: "agent's run passed, but plugin check failed: npm test" }],
  verdict: "contradicted",
};
const branchEraProof = { ...card.proof, lastEditIndex: undefined, lastEdit: 1 };

describe("report versions", () => {
  it("renders v1 cards without their proof and keeps the current version strict", () => {
    expect([...REPORT_SCHEMAS.keys()]).toEqual([1, 2, REPORT_VERSION]);
    const v1 = REPORT_SCHEMAS.get(1)!;
    expect(v1.parse({ ...card, proof: mainEraProof }).proof).toBeNull();
    expect(v1.parse({ ...card, proof: branchEraProof }).proof).toBeNull();
    expect(v1.parse({ ...card, proof: undefined }).verify).toEqual(card.verify);
    const current = REPORT_SCHEMAS.get(REPORT_VERSION)!;
    expect(current.parse(card)).toEqual(card);
    expect(current.safeParse({ ...card, proof: mainEraProof }).success).toBe(false);
  });

  it("v2 cards keep their failures but not a pass judged by the older rules (review F1, F5, F6, N1)", () => {
    expect(REPORT_VERSION).toBe(3);
    const v2 = REPORT_SCHEMAS.get(2)!;
    const { rules: _, ...v2Proof } = card.proof!;
    const claims = [
      { kind: "tests_pass", text: "All tests pass.", verdict: "verified", reason: "npm test; echo done passed" },
      { kind: "verified", text: "Verified.", verdict: "checked", reason: "ls exited 0" },
      { kind: "fixed", text: "Fixed.", verdict: "contradicted", reason: "last test command failed: npm test (exit 1)" },
      { kind: "done", text: "Done.", verdict: "check_failed", reason: "agent ran none, check failed: npm test" },
      { kind: "build_ok", text: "Build succeeds.", verdict: "mismatch", reason: "agent's run passed (npm run build), check failed: npm run build" },
    ];
    const parsed = v2.parse({ ...card, proof: { ...v2Proof, claims } }).proof!;
    const again = "judged by an older version of the plugin; Re-run to judge again";
    expect(parsed.claims.map((c) => [c.verdict, c.reason])).toEqual([
      ["unchecked", `npm test; echo done passed (${again})`],
      ["unchecked", `ls exited 0 (${again})`],
      ["contradicted", "last test command failed: npm test (exit 1)"],
      ["check_failed", "agent ran none, check failed: npm test"],
      ["mismatch", "agent's run passed (npm run build), check failed: npm run build"],
    ]);
    expect(parsed.rules).toBeUndefined();
    // The current schema keeps a v3 proof as it is.
    expect(REPORT_SCHEMAS.get(REPORT_VERSION)!.parse(card).proof?.claims[0]?.verdict).toBe("verified");
  });

  it("store: a v2 file loads with its old passes downgraded and saves as v3", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tr-store-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const { rules: _, ...v2Proof } = card.proof!;
    await writeFile(join(dir, "reports.json"), JSON.stringify({ version: 2, reports: [{ ...card, proof: v2Proof }] }));
    const [loaded] = await loadReports(dir);
    expect(loaded?.proof?.claims.map((c) => c.verdict)).toEqual(["unchecked"]);
    const saver = createSaver(dir, 0);
    saver.save([loaded!]);
    await saver.close();
    expect(JSON.parse(await readFile(join(dir, "reports.json"), "utf8")).version).toBe(3);
    expect((await loadReports(dir))[0]?.proof?.claims.map((c) => c.verdict)).toEqual(["unchecked"]);
  });

  it("store: a v1 file loads without proofs, a bad report is skipped, a newer file starts empty, saves use the current version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tr-store-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "reports.json");
    await writeFile(file, JSON.stringify({ version: 1, reports: [{ ...card, proof: mainEraProof }] }));
    expect((await loadReports(dir)).map((r) => [r.id, r.proof])).toEqual([["r1", null]]);

    await writeFile(file, JSON.stringify({ version: REPORT_VERSION, reports: [card, { ...card, id: "r2", proof: mainEraProof }] }));
    expect((await loadReports(dir)).map((r) => r.id)).toEqual(["r1"]);
    await writeFile(file, JSON.stringify({ version: REPORT_VERSION + 1, reports: [card] }));
    expect(await loadReports(dir)).toEqual([]);

    const saver = createSaver(dir, 0);
    saver.save([card]);
    await saver.close();
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(REPORT_VERSION);
    expect(await loadReports(dir)).toEqual([card]);
  });

  it("store: moves an unreadable or newer reports.json aside before anything can overwrite it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tr-store-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "reports.json");
    const newer = JSON.stringify({ version: REPORT_VERSION + 1, reports: [card] });

    await writeFile(file, "{ cut off mid-wri");
    expect(await loadReports(dir)).toEqual([]);
    await writeFile(file, newer);
    expect(await loadReports(dir)).toEqual([]);
    await writeFile(file, JSON.stringify({ version: REPORT_VERSION + 1, reports: [] }));
    expect(await loadReports(dir)).toEqual([]);
    const saver = createSaver(dir, 0);
    saver.save([card]);
    await saver.close();

    const next = `v${REPORT_VERSION + 1}`;
    expect((await readdir(dir)).sort()).toEqual(["reports.json", "reports.json.bad", `reports.json.${next}`, `reports.json.${next}.1`]);
    expect(await readFile(join(dir, "reports.json.bad"), "utf8")).toBe("{ cut off mid-wri");
    expect(await readFile(join(dir, `reports.json.${next}`), "utf8")).toBe(newer);
    expect(await loadReports(dir)).toEqual([card]);

    // If it cannot be moved, loading fails, and the caller keeps reports in memory instead of saving over it.
    await writeFile(file, "not json");
    await chmod(dir, 0o500);
    try {
      await expect(loadReports(dir)).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
