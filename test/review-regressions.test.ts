import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../server/host-types";
import { buildProof, evidenceFromProof, extractEvidence, matchClaims } from "../server/proof";

const edit: AgentTimelineItem = { type: "tool_call", callId: "edit", name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: "src.ts", oldString: "before", newString: "after" } };
const shell = (command: string, exitCode = 0, output = ""): AgentTimelineItem => {
  const detail = { type: "shell" as const, command, cwd: "/repo", exitCode, output };
  return exitCode
    ? { type: "tool_call", callId: command, name: "Bash", status: "failed", error: `Exit code ${exitCode}`, detail }
    : { type: "tool_call", callId: command, name: "Bash", status: "completed", error: null, detail };
};
function report(calls: AgentTimelineItem[], text = "All tests pass.", check: { command: string; passed: boolean } | null = null) {
  const timeline: AgentTimelineItem[] = [{ type: "user_message", text: "make the change", messageId: "start" }, edit, ...calls, { type: "assistant_message", text }];
  return buildProof(extractEvidence(timeline), check?.command ?? null, check, "claude");
}

describe("reviewed false-verification regressions", () => {
  it.each([
    ['npm test; echo "exit: $?" >&2', "1 failed\nexit: 1"],
    ['npm test; echo "exit: $?";', "1 failed\nexit: 1"],
    ['npm test; echo "exit: $?" # status', "1 failed\nexit: 1"],
    ['npm test; echo -e "exit: $?"', "1 failed\nexit: 1"],
    ['npm test; echo "status $? done"', "1 failed\nstatus 1 done"],
    ['npm test; echo "exit: $?"', ""],
    ["npm test; echo $? > status.txt", "1 failed"],
  ])("never verifies a failing or unobserved status: %s", (command, output) => {
    const proof = report([shell(command, 0, output)]);
    expect(proof.claims).toHaveLength(1);
    expect(proof.claims[0]).toMatchObject({ kind: "tests_pass" });
    expect(["contradicted", "unsupported"]).toContain(proof.claims[0]!.verdict);
  });

  it.each(["true || npm test", "git diff --quiet || npm test", "jest --listTests", "pytest --collect-only", "cargo test --no-run", "npm test --if-present", "vitest --version", "make -n test"])("does not treat a skipped/nonexecuting command as a test run: %s", (command) => {
    expect(report([shell(command)]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it.each(["npm test | tail -5", "npm test || true", "npm test; echo done", "jest --listTests", "trap 'exit 0' EXIT; npm test", "run_tests() { npm test; }"])("does not trust the configured check more than the agent command: %s", (command) => {
    expect(report([], "All tests pass.", { command, passed: true }).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it.each([
    "false && set -o pipefail; npm test | tail -5",
    "printf '' | set -o pipefail; npm test | tail -5",
    "{ set -o pipefail; } | cat; npm test | tail -5",
  ])("does not inherit shell options from a skipped or piped setting: %s", (command) => {
    expect(report([shell(command)]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it("does not let an unrelated successful command settle an unobserved background test", () => {
    const background: AgentTimelineItem = { type: "tool_call", callId: "bg", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test", output: "Command running in background with ID: bg-1" } };
    const proof = report([background, shell("git status")], "Verified.");
    expect(proof.claims[0]).toMatchObject({ kind: "verified", verdict: "unsupported" });
    expect(proof.claims[0]!.reason).toMatch(/background/i);
  });

  it("invalidates a passing run after a shell edit", () => {
    expect(report([shell("npm test"), shell("printf changed > src.ts")]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it("does not attribute a test in another directory to the repository", () => {
    expect(report([shell("cd /tmp/other && npm test")]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it("does not assume the initial cwd after an earlier call changed the provider's persistent directory", () => {
    const bash = (command: string): AgentTimelineItem => ({ type: "tool_call", callId: command, name: "Bash", status: "completed", error: null, detail: { type: "shell", command, output: "" } });
    expect(report([bash("cd /tmp/other"), bash("npm test")]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
    // An explicit per-call directory restores trustworthy scope, as supplied by Codex and other providers.
    expect(report([bash("cd /tmp/other"), shell("npm test")]).claims[0]).toMatchObject({ kind: "tests_pass", verdict: "verified" });
  });

  it("retains successful build and test evidence from a conjunction", () => {
    expect(report([shell("npm run build && npm test")], "Build succeeds. All tests pass.").claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "build_ok", verdict: "verified" }),
      expect.objectContaining({ kind: "tests_pass", verdict: "verified" }),
    ]));
  });

  it("does not revive an old passing verdict when its command cwd and intervening edits were not saved", () => {
    const { rules: _, ...legacy } = report([shell("npm test")]);
    // v0.1.0 did not save command cwd and kept only a bounded command list. The passing command may have run elsewhere
    // or before a shell edit that was dropped from that list, so its old exit 0 cannot establish a fresh verdict.
    const old = { ...legacy, commandsTotal: 30 };
    const again = buildProof(evidenceFromProof(old), null, null, "claude");
    expect(again.claims[0]).toMatchObject({ kind: "tests_pass", verdict: "unsupported" });
  });

  it("does not revive a mixed sentence extracted by the old zero-failure parser", () => {
    const { rules: _, ...legacy } = report([shell("npm test")]);
    legacy.claims[0]!.text = "Tests pass on Node 20.0 failed on 18.";
    const check = { command: "npm test", passed: true };
    expect(buildProof(evidenceFromProof(legacy), check.command, check, "claude").claims).toEqual([]);
  });
});

describe("passing summaries and mixed statements", () => {
  it.each(["Tests passed!", "Tests are all passing.", "Tests: 42 passed, 0 failed.", "The suite is green."])("recognizes an ordinary test claim: %s", (text) => {
    expect(matchClaims(text)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tests_pass" })]));
  });
  it.each(["None of the tests pass.", "Tests pass on Node 20.0 failed on 18.", "Build succeeds except v2.0 failed to build.", "Tests pass (fail 0, error 4)."])("does not extract a passing claim from a negative/mixed sentence: %s", (text) => {
    expect(matchClaims(text)).toEqual([]);
  });
});
