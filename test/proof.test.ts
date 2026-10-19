import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../server/host-types";
import { agentRanCheck, buildProof, commandKind, evidenceFromProof, extractEvidence, judgeClaims, matchClaims, sliceTurn, toRepoPath } from "../server/proof";

// Shapes follow the provider mappers in Paseo at 9bd58f66b (file:line in each comment).
const user = (text: string): AgentTimelineItem => ({ type: "user_message", text, messageId: `u-${text}` });
const say = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

// Claude: is_error tool_result -> status failed, detail has no output and no exitCode,
// error is the raw block with string content (claude/agent.ts:5580-5592, tool-call-mapper.ts:146-155).
const claudeBashFailed = (command: string, code: number): AgentTimelineItem => ({
  type: "tool_call",
  callId: "toolu_1",
  name: "Bash",
  status: "failed",
  detail: { type: "shell", command },
  error: { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: `Exit code ${code}\nFAIL src/a.test.ts\n  expected 2, got 3` },
});
const claudeBashOk = (command: string): AgentTimelineItem => ({
  type: "tool_call",
  callId: "toolu_2",
  name: "Bash",
  status: "completed",
  error: null,
  detail: { type: "shell", command, output: "ok" },
});
const claudeEdit = (filePath: string): AgentTimelineItem => ({
  type: "tool_call",
  callId: "toolu_3",
  name: "Edit",
  status: "completed",
  error: null,
  detail: { type: "edit", filePath, oldString: "a", newString: "b" },
});
// Codex: commandExecution with exitCode (codex/tool-call-mapper.ts:678-707).
const codexShell = (command: string, exitCode: number, status: "completed" | "failed"): AgentTimelineItem =>
  status === "failed"
    ? { type: "tool_call", callId: "call_9", name: "shell", status, error: { message: "command failed" }, detail: { type: "shell", command, cwd: "/repo", output: "boom", exitCode } }
    : { type: "tool_call", callId: "call_8", name: "shell", status, error: null, detail: { type: "shell", command, cwd: "/repo", output: "", exitCode } };
const claudeBashEcho = (command: string, output: string): AgentTimelineItem => ({
  type: "tool_call",
  callId: `toolu_e_${command}`,
  name: "Bash",
  status: "completed",
  error: null,
  detail: { type: "shell", command, output },
});
// Codex apply_patch with a renderable diff: one edit detail with a cwd-relative path (codex/tool-call-mapper.ts:875-886, v0.11.4).
const codexPatch = (filePath: string): AgentTimelineItem => ({
  type: "tool_call",
  callId: `call_patch_${filePath}`,
  name: "apply_patch",
  status: "completed",
  error: null,
  detail: { type: "edit", filePath, unifiedDiff: "@@ -1 +1 @@\n-a\n+b" },
});
// Claude: a denied permission ends the call failed, the deny message as the error content, no exit code (claude/agent.ts:5420-5429, v0.11.4).
const claudeDenied = (command: string, message = "Denied by user"): AgentTimelineItem => ({
  type: "tool_call",
  callId: `toolu_d_${command}`,
  name: "Bash",
  status: "failed",
  detail: { type: "shell", command },
  error: { type: "tool_result", tool_use_id: `toolu_d_${command}`, is_error: true, content: message },
});
// Codex: Paseo adds its own denied item, and the native item arrives declined, mapped to a plain failure
// (codex-app-server-agent.ts:4875-4909, tool-call-mapper-utils.ts:3-40, v0.11.4). The native item keeps its first position.
const codexDenied = (command: string, id: string): AgentTimelineItem[] => [
  { type: "tool_call", callId: id, name: "shell", status: "failed", error: { message: "Tool call failed" }, detail: { type: "shell", command, cwd: "/repo", exitCode: null } },
  { type: "tool_call", callId: `permission-appr-${id}`, name: "shell", status: "failed", error: { message: "Denied by user" }, detail: { type: "shell", command, cwd: "/repo" }, metadata: { permissionRequestId: `appr-${id}`, denied: true } },
];
// Codex multi-file apply_patch without renderable edit detail falls back to unknown with input.files (codex/tool-call-mapper.ts:98-107, 848-856).
const codexPatchUnknown: AgentTimelineItem = {
  type: "tool_call",
  callId: "call_p",
  name: "apply_patch",
  status: "completed",
  error: null,
  detail: { type: "unknown", input: { files: [{ path: "src/a.ts", kind: "update" }, { path: "test/a.test.ts", kind: "add" }] }, output: null },
};
// OpenCode: output is a plain string, so detail.exitCode is undefined; raw tool metadata rides on the item (opencode/tool-call-mapper.ts:56,66).
const opencodeBash = (command: string, exit: number): AgentTimelineItem => ({
  type: "tool_call",
  callId: "prt_1",
  name: "bash",
  status: "completed",
  error: null,
  detail: { type: "shell", command, output: "1 failing" },
  metadata: { exit, description: "run tests" },
});
// Claude Code: a Bash call moved to the background returns at once, status completed, no exit code; the result text
// is the Bash tool's (Claude Code 2.x). Paseo keeps it as the shell output (claude/agent.ts buildStructuredToolResult).
const claudeBackground = (command: string, id: string, how: "asked" | "timeout" = "asked"): AgentTimelineItem => ({
  type: "tool_call",
  callId: `toolu_bg_${id}`,
  name: "Bash",
  status: "completed",
  error: null,
  detail: {
    type: "shell",
    command,
    output:
      how === "asked"
        ? `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-501/ws/tasks/${id}.output. You will be notified when it completes. To check interim output, use Read on that file path.`
        : `> vitest run\n\nCommand did not complete within its 120s timeout and was moved to the background (ID: ${id}). Output is being written to: /tmp/claude-501/ws/tasks/${id}.output.`,
  },
});
// Its end, when it lands in the same turn: Paseo's synthetic task_notification call (claude/task-notification-tool-call.ts),
// with the raw status in metadata and Claude Code's summary ("completed (exit code N)", "failed with exit code N").
const claudeTaskNotification = (id: string, status: "completed" | "failed" | "killed", exitCode?: number): AgentTimelineItem => {
  const summary =
    status === "completed" ? `Background command "Run tests" completed${exitCode === undefined ? "" : ` (exit code ${exitCode})`}` : status === "failed" ? `Background command "Run tests" failed with exit code ${exitCode}` : `Background command "Run tests" was stopped`;
  const text = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_bg_${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const base = { type: "tool_call" as const, callId: `task_notification_${id}`, name: "task_notification", detail: { type: "plain_text" as const, label: summary, icon: "wrench" as const, text }, metadata: { synthetic: true, source: "claude_task_notification", taskId: id, toolUseId: `toolu_bg_${id}`, status } };
  return status === "failed" ? { ...base, status: "failed", error: { message: summary } } : { ...base, status: "completed", error: null };
};
// Or a TaskOutput call the agent made to wait for it; Paseo keeps the result text as an unknown detail's output.
const claudeTaskOutput = (id: string, status: string, exitCode: number | null): AgentTimelineItem => ({
  type: "tool_call",
  callId: `toolu_out_${id}`,
  name: "TaskOutput",
  status: "completed",
  error: null,
  detail: { type: "unknown", input: { task_id: id, block: true }, output: { output: `<retrieval_status>success</retrieval_status>\n<task_id>${id}</task_id>\n<task_type>local_bash</task_type>\n<status>${status}</status>${exitCode === null ? "" : `\n<exit_code>${exitCode}</exit_code>`}\n<output>\n1 failed\n</output>` } },
});
const plugin: AgentTimelineItem = { type: "plugin", id: "turn-report:x", pluginId: "turn-report", kind: "turn-report-card", version: 1, data: {} };

describe("sliceTurn", () => {
  const timeline = [user("one"), say("a"), plugin, user("two"), claudeBashOk("ls"), user("steer"), say("b")];

  it("starts at the first user message after the previous turn end, keeping steers", () => {
    expect(sliceTurn(timeline, 3)).toEqual(timeline.slice(3));
  });

  it("falls back to the last user message when the previous end is unknown or past the end", () => {
    expect(sliceTurn(timeline, null)).toEqual(timeline.slice(5));
    expect(sliceTurn(timeline, 99)).toEqual(timeline.slice(5));
  });

  it("takes only what followed the previous end for an autonomous turn, which has no user message", () => {
    // Claude Code, live: a background command finished after the turn that started it and woke the agent.
    const background = [user("run it in the background"), claudeBashOk("sleep 45; make"), say("running"), plugin, say("it finished")];
    expect(sliceTurn(background, 3)).toEqual([plugin, say("it finished")]);
  });

  it("returns everything when there is no user message", () => {
    expect(sliceTurn([say("x")], null)).toHaveLength(1);
  });
});

describe("extractEvidence", () => {
  it("reads exit codes per provider shape and failure status", () => {
    const ev = extractEvidence([
      user("go"),
      claudeBashFailed("npm test", 1),
      codexShell("pnpm vitest run", 1, "failed"),
      codexShell("git status", 0, "completed"),
      opencodeBash("pytest -q", 2),
      claudeBashOk("npx tsc --noEmit"),
    ]);
    expect(ev.commands.map((c) => [c.command, c.kind, c.exitCode, c.outcome])).toEqual([
      ["npm test", "test", 1, "failed"],
      ["pnpm vitest run", "test", 1, "failed"],
      ["git status", "other", 0, "ok"],
      ["pytest -q", "test", 2, "failed"],
      // Claude Code marks a non-zero Bash exit is_error, so a completed call exited 0.
      ["npx tsc --noEmit", "build", 0, "ok"],
    ]);
  });

  it("reads back a status the agent echoed with `$?`, since the tool call itself then succeeds", () => {
    const shell = (command: string, output: string, exitCode?: number): AgentTimelineItem => ({
      type: "tool_call",
      callId: `e-${command}`,
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command, output, ...(exitCode === undefined ? {} : { exitCode }) },
    });
    const ev = extractEvidence([
      user("go"),
      // Claude Code, verbatim from a real run: the test failed, the Bash call succeeded.
      shell('ls test.mjs; node test.mjs; echo "exit: $?"', "test.mjs\nFAIL add(2, 3): expected 5, got -1\nok   mul(4, 5)\n1 failed\nexit: 1"),
      shell('node test.mjs; echo "exit: $?"', "ok   add(2, 3)\nall passed\nexit: 0"),
      // Codex shape: the call's own exit code is the echo's.
      shell("npm test; echo $?", "FAIL a.test.ts\n2", 0),
      shell("echo 'price: $5'", "price: $5"),
      // Only a final echo speaks for the whole call.
      shell("false; echo $?; true", "1"),
    ]);
    expect(ev.commands.map((c) => [c.exitCode, c.outcome])).toEqual([
      [1, "failed"],
      [0, "ok"],
      [2, "failed"],
      [null, "ok"],
      [null, "ok"],
    ]);
  });

  it("collects written files including Codex multi-file patches, flags test files, ignores failed writes", () => {
    const failedWrite: AgentTimelineItem = { type: "tool_call", callId: "w", name: "Write", status: "failed", error: { message: "denied" }, detail: { type: "write", filePath: "secret.txt" } };
    const ev = extractEvidence([user("go"), claudeEdit("src/math.ts"), codexPatchUnknown, failedWrite, claudeEdit("src/math.ts")]);
    expect(ev.files).toEqual(["src/math.ts", "src/a.ts", "test/a.test.ts"]);
    expect(buildProof(ev, null, null, "codex").testFiles).toEqual(["test/a.test.ts"]);
    expect(ev.failedTools).toEqual([{ name: "Write", summary: "denied" }]);
  });

  it("counts a root-level test.mjs or tests.py as a test file", () => {
    const ev = extractEvidence([user("go"), claudeEdit("/repo/math.mjs"), claudeEdit("/repo/test.mjs"), codexPatch("calc/tests.py"), codexPatch("latest.mjs"), codexPatch("contest.ts")]);
    expect(buildProof(ev, null, null, "claude").testFiles).toEqual(["/repo/test.mjs", "calc/tests.py"]);
  });

  it("buckets permission denials apart from failures, by deny message or Codex's denied flag", () => {
    const eacces = { ...(claudeBashFailed("./run.sh", 126) as object), error: { type: "tool_result", is_error: true, content: "Exit code 126\n/bin/sh: ./run.sh: Permission denied" } } as AgentTimelineItem;
    const ev = extractEvidence([
      user("go"),
      claudeDenied("npm test"),
      claudeDenied("pnpm test", "Permission request denied"),
      claudeDenied("rm -rf dist", "Permission to use Bash with command rm -rf dist has been denied."),
      claudeDenied("ls", "The user answered with a message instead of approving. Their message follows."),
      eacces,
      { type: "tool_call", callId: "oc", name: "bash", status: "failed", error: "The user rejected permission to use this specific tool call.", detail: { type: "shell", command: "make" } },
    ]);
    expect(ev.commands.map((c) => c.outcome)).toEqual(["denied", "denied", "denied", "denied", "failed", "denied"]);
  });

  it("counts a Codex denial once, though Codex also reports the declined item, and never as a failed tool", () => {
    const ev = extractEvidence([user("go"), ...codexDenied("npm test", "exec-1"), codexShell("npm test", 1, "failed")]);
    expect(ev.commands.map((c) => [c.command, c.outcome])).toEqual([
      ["npm test", "denied"],
      ["npm test", "failed"],
    ]);
    expect(ev.commandsTotal).toBe(2);
    const patch = extractEvidence([
      user("go"),
      { type: "tool_call", callId: "patch-1", name: "apply_patch", status: "failed", error: { message: "Tool call failed" }, detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "@@" } },
      { type: "tool_call", callId: "permission-patch-1", name: "apply_patch", status: "failed", error: { message: "Denied by user" }, detail: { type: "unknown", input: { reason: "write outside" }, output: null }, metadata: { permissionRequestId: "patch-1", denied: true } },
      { type: "tool_call", callId: "w", name: "Write", status: "failed", error: { type: "tool_result", is_error: true, content: "Denied by user" }, detail: { type: "write", filePath: "/etc/hosts" } },
    ]);
    expect(patch.failedTools).toEqual([]);
    expect(patch.files).toEqual([]);
  });

  it("maps timeline paths onto git's repo-relative ones, through a symlinked cwd", () => {
    const dirs = { root: "/private/tmp/ws", cwd: "/tmp/ws/app", realCwd: "/private/tmp/ws/app" };
    expect(["/private/tmp/ws/app/calc/math.mjs", "calc/math.mjs", "/tmp/ws/app/notes.md", "../README.md", "/etc/hosts"].map((p) => toRepoPath(p, dirs))).toEqual([
      "app/calc/math.mjs",
      "app/calc/math.mjs",
      "app/notes.md",
      "README.md",
      "/etc/hosts",
    ]);
  });

  it("skips a malformed tool call and keeps the rest of the turn", () => {
    const noDetail = { type: "tool_call", callId: "x1", name: "Bash", status: "completed", error: null } as unknown as AgentTimelineItem;
    const objectOutput = { type: "tool_call", callId: "x2", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test", output: { text: "?" } } } as unknown as AgentTimelineItem;
    const noCommand = { type: "tool_call", callId: "x3", name: "Bash", status: "failed", error: null, detail: { type: "shell" } } as unknown as AgentTimelineItem;
    const nullItem = null as unknown as AgentTimelineItem;
    const ev = extractEvidence([user("go"), claudeEdit("src/a.ts"), noDetail, objectOutput, noCommand, nullItem, claudeBashOk("npx vitest run"), say("All tests pass.")]);
    expect(ev.commands.map((c) => [c.command, c.outcome])).toEqual([["npx vitest run", "ok"]]);
    expect(judgeClaims(matchClaims("All tests pass."), ev, null)[0]?.verdict).toBe("verified");
    // A malformed item after a background command does not break the search for its end.
    const bg = extractEvidence([user("go"), claudeBackground("npm test", "b9"), noDetail, claudeTaskNotification("b9", "completed", 0)]);
    expect(bg.commands.map((c) => c.outcome)).toEqual(["ok"]);
  });

  it("takes the last assistant message as the final message", () => {
    expect(extractEvidence([user("go"), say("first"), claudeBashOk("ls"), say("All tests pass.")]).finalMessage).toBe("All tests pass.");
  });

  it("classifies common check commands", () => {
    expect(["cargo test", "go test ./...", "npm run test:unit", "node test.mjs", "yarn jest"].map(commandKind)).toEqual(["test", "test", "test", "test", "test"]);
    expect(["pnpm build", "tsc -p .", "eslint .", "cat x"].map(commandKind)).toEqual(["build", "build", "lint", "other"]);
  });

  it("classifies a command by the program each segment runs, never by a word anywhere in the line", () => {
    const kinds = (commands: string[]) => Object.fromEntries(commands.map((c) => [c, commandKind(c)]));
    const reads = ["cat math.mjs test.mjs", "sed -n 1p vitest.config.ts", "sed -n '1,40p' vitest.config.ts", "rg -n jest", "rg -n jest src", "cat .eslintrc", "npm ls vitest", "pip install pytest", "grep -r pytest .", "cat test.mjs", "pnpm add -D vitest", 'git commit -m "fix tests"', 'echo "npm test"', "cat calc/math.mjs && cat test.mjs && rg --files -g AGENTS.md calc"];
    expect(kinds(reads)).toEqual(Object.fromEntries(reads.map((c) => [c, "other"])));
    const tests = ["npx vitest run", "pnpm vitest run", "pytest -q", 'node test.mjs; echo "exit: $?"', "CI=1 npm test", "cd web && npm test -- --run", "npm --prefix web run test:unit", "pnpm --filter api test", "yarn workspace api test", "pnpm exec jest", "npm exec -- vitest", "bunx vitest", "bun test", "uv run pytest", "uv run --with pytest pytest -x", "poetry run pytest", "python -m pytest", ".venv/bin/python -m unittest", "./node_modules/.bin/vitest run", "npx playwright test", "node --test", "./test.sh", "bash -lc 'npm test'", "timeout 60 npm test", "(cd web && npx vitest run)", "./mvnw -q test", "node test.mjs && node e2e.mjs", "npm test 2>&1"];
    expect(kinds(tests)).toEqual(Object.fromEntries(tests.map((c) => [c, "test"])));
    const builds = ["npx tsc --noEmit", "npm run typecheck", "yarn tsc", "cargo check", "go vet ./..."];
    expect(kinds(builds)).toEqual(Object.fromEntries(builds.map((c) => [c, "build"])));
    const lints = ["npm run lint", "npx eslint .", "ruff check .", "cargo clippy", "npx prettier --check ."];
    expect(kinds(lints)).toEqual(Object.fromEntries(lints.map((c) => [c, "lint"])));
    // Mixed lines take the highest kind they run.
    expect(commandKind("npm run build && npm test")).toBe("test");
  });
});

describe("matchClaims", () => {
  it("finds the common claims", () => {
    const claims = matchClaims("I fixed the off-by-one in `sum`.\n\nAll tests pass and the build succeeds. Verified locally. Done.");
    expect(claims.map((c) => c.kind)).toEqual(["fixed", "tests_pass", "build_ok", "verified", "done"]);
  });

  it("ignores negated, hedged and planned claims, and code blocks", () => {
    expect(matchClaims("Tests are not passing yet.")).toEqual([]);
    expect(matchClaims("I couldn't verify this. Once the tests pass I will merge.")).toEqual([]);
    expect(matchClaims("Should I run the tests?")).toEqual([]);
    expect(matchClaims("```\n12 tests passed\n```")).toEqual([]);
    expect(matchClaims("2 tests are failing; I fixed one of them.")).toEqual([]);
  });

  it("takes any n't word as a negation, with straight or curly apostrophes", () => {
    const refusal = 'I started `npm test` in the background. I won\'t end with "All tests pass" because I haven\'t seen any results, so I don\'t know whether the tests passed.';
    expect(matchClaims(refusal)).toEqual([]);
    for (const sentence of ["Tests don't pass.", "The tests haven't passed.", "The build isn't clean.", "The build isn’t clean.", "Tests aren’t passing.", "It wasn't fixed.", "Tests didn't pass."]) {
      expect([sentence, matchClaims(sentence)]).toEqual([sentence, []]);
    }
    expect(matchClaims("Fixed: tests pass.").map((c) => c.kind)).toEqual(["tests_pass", "fixed"]);
  });

  it("matches counts like '42 tests passed'", () => {
    expect(matchClaims("42 tests passed.").map((c) => c.kind)).toEqual(["tests_pass"]);
  });

  it("reads a zero failure count as part of the claim, not as a negation", () => {
    const claude =
      "Tests pass: `node test.mjs` reports 2 passed and 0 failed, after I fixed `cartTotal` in `cart.mjs:3` to add up `item.price * item.qty` instead of just `item.price`. I didn't run `test-e2e.mjs`, so the end-to-end tests haven't been checked against this change.";
    expect(matchClaims(claude).map((c) => c.kind)).toEqual(["tests_pass", "fixed"]);
    for (const sentence of ["12 passed, 0 failed.", "All tests pass (0 failing).", "All 5 tests pass, no tests failed.", "Tests pass: pass 5, fail 0."]) {
      expect([sentence, matchClaims(sentence).map((c) => c.kind)]).toEqual([sentence, ["tests_pass"]]);
    }
    for (const sentence of ["3 passed, 1 failed.", "10 failed, 2 passed.", "2 passed and 0 failed, but I didn't run the e2e suite."]) {
      expect([sentence, matchClaims(sentence)]).toEqual([sentence, []]);
    }
  });
});

describe("judgeClaims", () => {
  const testsPass = matchClaims("All tests pass.");
  const failed = extractEvidence([user("go"), claudeBashOk("npm test"), claudeBashFailed("npm test", 1)]);
  const passed = extractEvidence([user("go"), claudeBashFailed("npm test", 1), claudeBashOk("npm test")]);
  const none = extractEvidence([user("go")]);

  it("contradicts a claim when the last matching command failed", () => {
    expect(judgeClaims(testsPass, failed, null)[0]).toMatchObject({ verdict: "contradicted", reason: "last test command failed: npm test (exit 1)" });
  });

  it("verifies when the last matching command passed", () => {
    expect(judgeClaims(testsPass, passed, null)[0]?.verdict).toBe("verified");
  });

  it("reads 'check failed after claim', not contradicted, when the agent ran nothing and the plugin check failed", () => {
    expect(judgeClaims(testsPass, none, { command: "node test.mjs", passed: false })[0]).toMatchObject({ verdict: "check_failed", reason: "agent ran none, check failed: node test.mjs" });
  });

  it("judges on the agent's own record after its last edit", () => {
    const stale = extractEvidence([user("go"), claudeBashFailed("npm test", 1), claudeEdit("src/math.ts"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, stale, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit" });
    const fresh = extractEvidence([user("go"), claudeEdit("src/math.ts"), claudeBashFailed("npm test", 1), say("All tests pass.")]);
    expect(judgeClaims(testsPass, fresh, null)[0]?.verdict).toBe("contradicted");
  });

  it("is unsupported when nothing ran, but never nags on a bare 'done'", () => {
    expect(judgeClaims(testsPass, none, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran this turn" });
    expect(judgeClaims(matchClaims("Done."), none, null)[0]).toMatchObject({ verdict: "unchecked", reason: "no matching command ran this turn" });
    expect(judgeClaims(matchClaims("Done."), failed, null)[0]?.verdict).toBe("contradicted");
  });

  it("backs 'verified' only with a test, build or lint run or the plugin check, never with an ad-hoc exit 0 (review F5)", () => {
    const verified = matchClaims("Verified both files exist.");
    const adHoc = extractEvidence([user("go"), claudeEdit("make_report.py"), codexShell("ls -la out/", 0, "completed")]);
    expect(judgeClaims(verified, adHoc, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit" });
    expect(judgeClaims(verified, adHoc, { command: "npm test", passed: true })[0]).toMatchObject({ verdict: "verified", reason: "agent ran none, check passed: npm test" });
    expect(judgeClaims(verified, adHoc, { command: "npm test", passed: false })[0]).toMatchObject({ verdict: "check_failed", reason: "agent ran none, check failed: npm test" });
    const tested = extractEvidence([user("go"), claudeEdit("make_report.py"), claudeBashFailed("npm test", 1), codexShell("ls -la out/", 0, "completed")]);
    expect(judgeClaims(verified, tested, null)[0]?.verdict).toBe("contradicted");
    for (const command of ["git status", "cat out/report.txt", "echo ok", "ls out/ | head"]) {
      const ev = extractEvidence([user("go"), claudeEdit("make_report.py"), claudeBashOk(command)]);
      expect([command, judgeClaims(matchClaims("Verified."), ev, null)[0]?.verdict]).toEqual([command, "unsupported"]);
    }
  });

  it("keeps the unsettled note when a read-only command follows a piped or background run (review F5)", () => {
    const verified = matchClaims("Verified.");
    const piped = extractEvidence([user("go"), claudeEdit("src/a.ts"), claudeBashOk("npm test | tail -5"), claudeBashOk("git status")]);
    expect(judgeClaims(verified, piped, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit (exit unknown, piped or chained: npm test | tail -5)" });
    const background = extractEvidence([user("go"), claudeEdit("src/a.ts"), claudeBackground("npm test", "bg1"), claudeBashOk("git status")]);
    expect(judgeClaims(verified, background, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit (in background, no result: npm test)" });
  });

  it("never contradicts a claim with a denied run: the command did not run", () => {
    const ev = extractEvidence([user("go"), claudeEdit("src/math.ts"), claudeDenied("npm test"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, ev, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit (denied: npm test)" });
    const codex = extractEvidence([user("go"), ...codexDenied("npm test", "exec-2"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, codex, { command: "npm test", passed: false })[0]?.verdict).toBe("check_failed");
  });

  it("never takes a command moved to the background as evidence, and never as a failure", async () => {
    const turn = [user("go"), claudeEdit("src/math.ts"), claudeBackground("npm test", "b7k2x9"), say("Fixed. All tests pass and verified.")];
    const ev = extractEvidence(turn);
    expect(ev.commands.map((c) => [c.command, c.exitCode, c.outcome])).toEqual([["npm test", null, "background"]]);
    expect(judgeClaims(matchClaims("All tests pass. Verified."), ev, null).map((c) => [c.kind, c.verdict, c.reason])).toEqual([
      ["tests_pass", "unsupported", "no matching command ran after the last edit (in background, no result: npm test)"],
      ["verified", "unsupported", "no matching command ran after the last edit (in background, no result: npm test)"],
    ]);
    const { proofFacts } = await import("../client/format");
    expect(proofFacts(buildProof(ev, null, null, "claude"))).toBe("1 command, 1 in background · 1 file written");
    const timedOut = extractEvidence([user("go"), claudeBackground("npx vitest run", "t1", "timeout")]);
    expect(timedOut.commands.map((c) => c.outcome)).toEqual(["background"]);
    // An ordinary command that prints the phrase mid-output is not one.
    const server = extractEvidence([user("go"), { ...(claudeBashOk("npm run dev") as object), detail: { type: "shell", command: "npm run dev", output: "ready\nserver running in background with ID: 4" } } as AgentTimelineItem]);
    expect(server.commands.map((c) => c.outcome)).toEqual(["ok"]);
  });

  it("takes a background command's end from a later report in the same turn", () => {
    const failed = extractEvidence([user("go"), claudeBackground("npm test", "b1"), claudeTaskNotification("b1", "failed", 1), say("All tests pass.")]);
    expect(failed.commands.map((c) => [c.exitCode, c.outcome])).toEqual([[1, "failed"]]);
    expect(failed.failedTools).toEqual([]);
    expect(judgeClaims(matchClaims("All tests pass."), failed, null)[0]).toMatchObject({ verdict: "contradicted", reason: "last test command failed: npm test (exit 1)" });

    const passed = extractEvidence([user("go"), claudeBackground("npm test", "b2"), claudeTaskNotification("b2", "completed", 0)]);
    expect(passed.commands.map((c) => [c.exitCode, c.outcome])).toEqual([[0, "ok"]]);
    expect(judgeClaims(matchClaims("All tests pass."), passed, null)[0]?.verdict).toBe("verified");

    const noCode = extractEvidence([user("go"), claudeBackground("npm test", "b3"), claudeTaskNotification("b3", "completed")]);
    expect(noCode.commands.map((c) => [c.exitCode, c.outcome])).toEqual([[null, "ok"]]);
    const stopped = extractEvidence([user("go"), claudeBackground("npm test", "b4"), claudeTaskNotification("b4", "killed")]);
    expect(stopped.commands.map((c) => c.outcome)).toEqual(["canceled"]);

    const waited = extractEvidence([user("go"), claudeBackground("npm test", "b5"), claudeTaskOutput("b5", "running", null), claudeTaskOutput("b5", "completed", 1)]);
    expect(waited.commands.map((c) => [c.exitCode, c.outcome])).toEqual([[1, "failed"]]);
    const stillRunning = extractEvidence([user("go"), claudeBackground("npm test", "b6"), claudeTaskOutput("b6", "running", null)]);
    expect(stillRunning.commands.map((c) => c.outcome)).toEqual(["background"]);
    // Another task's report says nothing about this one.
    const other = extractEvidence([user("go"), claudeBackground("npm test", "b7"), claudeTaskNotification("zz", "completed", 0)]);
    expect(other.commands.map((c) => c.outcome)).toEqual(["background"]);
  });

  it("reading or searching a test config is no test run, and a search with no match is no failed test (review S2)", () => {
    const read = extractEvidence([user("go"), codexPatch("src/a.ts"), codexShell("sed -n '1,40p' vitest.config.ts", 0, "completed"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, read, null)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran after the last edit" });
    const searched = extractEvidence([user("go"), codexPatch("src/a.ts"), codexShell("npx vitest run", 0, "completed"), codexShell("rg -n jest src", 1, "failed"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, searched, null)[0]).toMatchObject({ verdict: "verified", reason: "npx vitest run passed" });
    const catAfterFailure = extractEvidence([user("go"), codexPatch("math.mjs"), codexShell("node test.mjs", 1, "failed"), codexShell("cat test.mjs", 0, "completed"), say("All tests pass.")]);
    expect(judgeClaims(testsPass, catAfterFailure, null)[0]?.verdict).toBe("contradicted");
  });

  it("takes a test piped into another command, or chained with || or ;, as exit unknown: no evidence, no failure (review S3)", async () => {
    const piped = 'npx vitest run 2>&1 | tail -5';
    const ev = extractEvidence([user("go"), claudeEdit("src/a.ts"), claudeBashEcho(piped, " Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)"), say("All tests pass.")]);
    expect(ev.commands.map((c) => [c.kind, c.exitCode, c.outcome])).toEqual([["test", null, "unknown"]]);
    expect(judgeClaims(testsPass, ev, null)[0]).toMatchObject({ verdict: "unsupported", reason: `no matching command ran after the last edit (exit unknown, piped or chained: ${piped})` });
    const { proofFacts } = await import("../client/format");
    expect(proofFacts(buildProof(ev, null, null, "claude"))).toBe("1 command, 1 exit unknown · 1 file written");
    const { checkProvenance } = await import("../client/format");
    expect(checkProvenance(buildProof(ev, "npx vitest run", null, "claude"), "skipped")).toBe("npx vitest run: agent ran it, exit unknown (piped or chained); plugin check skipped");

    const unknown = ['npx vitest run | tail -5; echo "exit: $?"', "npm test || true", "npm test; npm run lint", "npm test &", "(npm test) | tee log", "! npm test", "bash -c 'npm test | tail'"];
    for (const command of unknown) {
      const failedLine = extractEvidence([user("go"), codexShell(command, 1, "failed")]);
      const passedLine = extractEvidence([user("go"), codexShell(command, 0, "completed")]);
      expect([command, failedLine.commands[0]?.outcome, passedLine.commands[0]?.outcome]).toEqual([command, "unknown", "unknown"]);
    }
    // With pipefail, or when the test's status reaches the end of the line, the run settles.
    // A failed `npm run build && npm test` does not say which run failed; on success both passed.
    expect(extractEvidence([user("go"), codexShell("npm run build && npm test", 1, "failed")]).commands.map((c) => [c.kind, c.outcome])).toEqual([["build", "unknown"], ["test", "unknown"]]);
    expect(extractEvidence([user("go"), codexShell("npm run build && npm test", 0, "completed")]).commands.map((c) => [c.kind, c.outcome])).toEqual([["build", "ok"], ["test", "ok"]]);
    const settles = ["set -o pipefail; npx vitest run | tail -5", "set -euo pipefail\nnpx vitest run 2>&1 | tail -5", "cd web && npm test 2>&1", "npm test && echo ok", "timeout 60 npm test"];
    for (const command of settles) {
      expect([command, extractEvidence([user("go"), codexShell(command, 1, "failed")]).commands[0]?.outcome]).toEqual([command, "failed"]);
    }
    // Other commands keep their exit status as before.
    expect(extractEvidence([user("go"), codexShell("ls out/ | head", 0, "completed")]).commands[0]?.outcome).toBe("ok");
  });

  it("for claims that accept several kinds, a failed last run of any kind contradicts, whatever passed after it (review S4)", () => {
    for (const message of ["Fixed.", "Verified the change.", "Done."]) {
      const claims = matchClaims(message);
      const testThenBuild = extractEvidence([user("go"), codexPatch("src/a.ts"), codexShell("npm test", 1, "failed"), codexShell("npx tsc --noEmit", 0, "completed"), say(message)]);
      expect([message, judgeClaims(claims, testThenBuild, null)[0]]).toMatchObject([message, { verdict: "contradicted", reason: "last test command failed: npm test (exit 1)" }]);
      const buildThenTest = extractEvidence([user("go"), codexPatch("src/a.ts"), codexShell("npx tsc --noEmit", 2, "failed"), codexShell("npm test", 0, "completed"), say(message)]);
      expect([message, judgeClaims(claims, buildThenTest, null)[0]?.verdict]).toEqual([message, "contradicted"]);
      // Each kind's last run decides: a failed test fixed by a later passing one does not count.
      const retried = extractEvidence([user("go"), codexPatch("src/a.ts"), codexShell("npm test", 1, "failed"), codexShell("npx tsc --noEmit", 0, "completed"), codexShell("npm test", 0, "completed"), say(message)]);
      expect([message, judgeClaims(claims, retried, null)[0]]).toMatchObject([message, { verdict: "verified", reason: "npm test passed" }]);
    }
  });

  it("counts the plugin check only for claims that accept its kind: a lint check does not verify 'tests pass' (review S5)", () => {
    const lint = { command: "npm run lint", passed: true };
    expect(judgeClaims(testsPass, none, lint)[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran this turn (check not counted, npm run lint runs no tests)" });
    expect(judgeClaims(testsPass, passed, { ...lint, passed: false })[0]).toMatchObject({ verdict: "verified", reason: "npm test passed" });
    expect(judgeClaims(matchClaims("Build succeeds."), none, { command: "npm test", passed: true })[0]?.reason).toBe("no matching command ran this turn (check not counted, npm test runs no build)");
    expect(judgeClaims(matchClaims("Verified."), none, lint)[0]?.verdict).toBe("verified");
    // A check the classifier cannot place (make ci, ./check.sh) settles no claim.
    expect(judgeClaims(matchClaims("Verified."), none, { command: "make ci", passed: true })[0]).toMatchObject({ verdict: "unsupported", reason: "no matching command ran this turn (check not counted, make ci runs no test, build or lint)" });
    expect(judgeClaims(matchClaims("Done."), failed, { command: "./check.sh", passed: false })[0]?.verdict).toBe("contradicted");
  });

  it("judges every command of the turn and stores at most 12, keeping the ones the verdict rests on (review S1)", () => {
    const reads = Array.from({ length: 14 }, (_, i) => codexShell(`sed -n '${i * 40 + 1},${i * 40 + 40}p' src/a.ts`, 0, "completed"));
    const turn = (message: string) => [user("go"), codexPatch("src/a.ts"), codexShell("npx vitest run", 1, "failed"), ...reads, say(message)];
    const ev = extractEvidence(turn("All tests pass."));
    expect([ev.commands.length, ev.commandsTotal]).toEqual([15, 15]);
    expect(judgeClaims(matchClaims("All tests pass."), ev, null)[0]).toMatchObject({ verdict: "contradicted", reason: "last test command failed: npx vitest run (exit 1)" });
    expect(judgeClaims(matchClaims("Verified the change."), ev, null)[0]?.verdict).toBe("contradicted");

    const proof = buildProof(ev, "npx vitest run", { command: "npx vitest run", passed: true }, "codex");
    expect(proof.commands).toHaveLength(12);
    expect(proof.commandsTotal).toBe(15);
    expect(proof.commands[0]?.command).toBe("npx vitest run");
    expect(proof.commands.slice(1).map((c) => c.command)).toEqual(reads.slice(-11).map((r) => (r as { detail: { command: string } }).detail.command));
    expect(proof.check.agentRan).toEqual({ exitCode: 1, outcome: "failed" });
    // Re-run judges the stored list the same way.
    const again = buildProof(evidenceFromProof(proof), "npx vitest run", { command: "npx vitest run", passed: false }, "codex");
    expect(again.claims.map((c) => [c.kind, c.verdict])).toEqual([["tests_pass", "contradicted"]]);
    expect(again.check.agentRan).toEqual({ exitCode: 1, outcome: "failed" });
  });

  it("quotes only the first line of a long or multi-line command", () => {
    const script = `pytest -q <<'PY'\nignored\nPY`;
    const ev = extractEvidence([user("go"), claudeEdit("make_report.py"), codexShell(script, 1, "failed")]);
    expect(judgeClaims(matchClaims("Verified."), ev, null)[0]?.reason).toBe("last test command failed: pytest -q <<'PY' ... (exit 1)");
    const long = `pytest -k "${"x".repeat(100)}"`;
    const ev2 = extractEvidence([user("go"), codexShell(long, 1, "failed")]);
    expect(judgeClaims(matchClaims("Verified."), ev2, null)[0]?.reason).toBe(`last test command failed: ${long.slice(0, 77)}... (exit 1)`);
  });
});

describe("recorded agent runs", async () => {
  const { claimLine, proofLabel, proofTone } = await import("../client/format");
  const t4bCheck = { command: "node test.mjs && node test-e2e.mjs", passed: false };
  const prompt = user("Fix add in calc/math.mjs, then run node test.mjs to confirm.");

  it("T4b, Claude: a true 'fixed' next to an unrelated failing check is a mismatch, never contradicted", () => {
    const turn = [
      prompt,
      claudeEdit("/private/tmp/ws/calc/math.mjs"),
      claudeBashEcho('node test.mjs; echo "exit: $?"', "ok   add(2, 3)\nok   mul(4, 5)\nall passed\nexit: 0"),
      say("Fixed `add` in `calc/math.mjs`: it returned `a - b`. `node test.mjs` passes now."),
    ];
    const proof = buildProof(extractEvidence(turn), t4bCheck.command, t4bCheck, "claude");
    // "`node test.mjs` passes now." is a tests_pass claim too (review F9).
    expect(proof.claims.map((c) => [c.kind, c.verdict])).toEqual([["fixed", "mismatch"], ["tests_pass", "mismatch"]]);
    expect(claimLine(proof.claims[0]!)).toBe('"fixed": agent and check disagree, agent\'s run passed (node test.mjs; echo "exit: $?"), check failed: node test.mjs && node test-e2e.mjs');
    expect([proofLabel(proof), proofTone(proof)]).toEqual(["Agent and check disagree", "warning"]);
  });

  it("T4b, Codex: same verdict from exit codes, and an earlier noisy rg exit 1 does not count", () => {
    const turn = [
      prompt,
      codexShell("cat calc/math.mjs && cat test.mjs && rg --files -g AGENTS.md calc", 1, "failed"),
      codexPatch("calc/math.mjs"),
      codexShell("node test.mjs", 0, "completed"),
      say("Fixed `add` in calc/math.mjs: it subtracted instead of adding. node test.mjs passes."),
    ];
    const proof = buildProof(extractEvidence(turn), t4bCheck.command, t4bCheck, "codex");
    expect(proof.claims.map((c) => [c.kind, c.verdict, c.reason])).toEqual([["fixed", "mismatch", "agent's run passed (node test.mjs), check failed: node test.mjs && node test-e2e.mjs"]]);
    expect(proofLabel(proof)).toBe("Agent and check disagree");
  });

  it("Codex T1: 'Verified both files exist' after its own ls stays unverified, not backed (review F5)", () => {
    const turn = [
      user("Write make_report.py ... Run it with .venv/bin/python and confirm both files exist."),
      codexPatch("make_report.py"),
      codexShell(".venv/bin/python make_report.py", 0, "completed"),
      codexShell("ls -la out/", 0, "completed"),
      say("Wrote make_report.py and ran it with .venv/bin/python. Verified both files exist: out/weekly-report.pdf and out/metrics.xlsx."),
    ];
    const proof = buildProof(extractEvidence(turn), null, null, "codex");
    expect(claimLine(proof.claims[0]!)).toBe('"verified": unverified, no matching command ran after the last edit');
    expect([proofLabel(proof), proofTone(proof)]).toEqual(["Claim unverified", "warning"]);
  });

  it("Codex T2: 'Verified the PDF still has 2 pages' after its own Python check stays unverified (review F5)", () => {
    const pages = `.venv/bin/python -c "import re; print(len(re.findall(rb'/Type\\s*/Page\\b', open('out/weekly-report.pdf','rb').read())))"`;
    const turn = [
      user("Review notes from the document viewer. ..."),
      codexPatch("inputs/highlights.md"),
      codexShell(".venv/bin/python make_report.py", 0, "completed"),
      codexShell(pages, 0, "completed"),
      say("Lightened the table header, shaded the weekend rows and corrected the Thursday highlight. Verified the PDF still has 2 pages."),
    ];
    const proof = buildProof(extractEvidence(turn), null, null, "codex");
    expect(proof.claims.map((c) => [c.kind, c.verdict])).toEqual([["verified", "unsupported"]]);
    expect(proofTone(proof)).toBe("warning");
  });
});

describe("recorded agent runs, denials", async () => {
  const { checkProvenance, proofFacts } = await import("../client/format");
  it("Claude T1: two denied commands read as denied, not failed", () => {
    const turn = [
      user("Write make_report.py ... Run it with .venv/bin/python and confirm both files exist."),
      claudeEdit("/private/tmp/ws/make_report.py"),
      claudeBashOk(".venv/bin/python make_report.py"),
      claudeBashOk("ls -la out/"),
      claudeDenied("cd /private/tmp && rm -rf xlcheck && mkdir xlcheck && cp /private/tmp/ws/out/metrics.xlsx xlcheck/"),
      claudeDenied("soffice --headless --convert-to csv --outdir /private/tmp/ws/out out/metrics.xlsx"),
      claudeBashFailed(".venv/bin/python -c \"import pandas\"", 1),
      claudeBashOk(".venv/bin/python -c \"from openpyxl import load_workbook; print(load_workbook('out/metrics.xlsx').sheetnames)\""),
      say("Both files exist: out/weekly-report.pdf (2 pages) and out/metrics.xlsx."),
    ];
    const proof = buildProof(extractEvidence(turn), null, null, "claude");
    expect(proofFacts(proof)).toBe("6 commands, 1 failed, 2 denied · 1 file written");
  });

  it("counts a denied Edit or Write with the denied commands", () => {
    const deniedWrite: AgentTimelineItem = { type: "tool_call", callId: "toolu_w", name: "Write", status: "failed", detail: { type: "write", filePath: "/etc/hosts" }, error: { type: "tool_result", is_error: true, content: "Permission to use Write has been denied." } };
    const deniedEdit: AgentTimelineItem = { type: "tool_call", callId: "toolu_e", name: "Edit", status: "failed", detail: { type: "edit", filePath: "/repo/.env" }, error: { type: "tool_result", is_error: true, content: "Denied by user" } };
    const turn = [user("go"), claudeEdit("/repo/make_report.py"), claudeBashOk("ls out/"), claudeDenied("rm -rf /repo/xlcheck"), deniedWrite, deniedEdit, say("Both files exist.")];
    const proof = buildProof(extractEvidence(turn), null, null, "claude");
    expect(proof.deniedTools).toEqual([
      { name: "Write", summary: "/etc/hosts" },
      { name: "Edit", summary: "/repo/.env" },
    ]);
    expect(proof.failedTools).toEqual([]);
    expect(proofFacts(proof)).toBe("2 commands, 3 denied · 1 file written");
    // Codex reports a denied patch twice: once counted.
    const codex = extractEvidence([
      user("go"),
      { type: "tool_call", callId: "patch-1", name: "apply_patch", status: "failed", error: { message: "Tool call failed" }, detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "@@" } },
      { type: "tool_call", callId: "permission-patch-1", name: "apply_patch", status: "failed", error: { message: "Denied by user" }, detail: { type: "unknown", input: { reason: "write outside" }, output: null }, metadata: { permissionRequestId: "patch-1", denied: true } },
    ]);
    expect(proofFacts(buildProof(codex, null, null, "codex"))).toBe("0 commands, 1 denied · 0 files written");
  });

  it("says the agent's run of the check was denied", () => {
    const proof = buildProof(extractEvidence([user("go"), claudeDenied("npm test")]), "npm test", { command: "npm test", passed: false }, "claude");
    expect(checkProvenance(proof, "failed")).toBe("npm test: agent's run was denied; plugin failed");
  });
});

describe("buildProof", () => {
  it("records whether the agent ran the configured check and the overall verdict", () => {
    const turn = [user("fix sum"), claudeEdit("test/math.test.js"), codexShell("node test.mjs", 1, "failed"), say("Fixed. All tests pass.")];
    const proof = buildProof(extractEvidence(turn), "node test.mjs", { command: "node test.mjs", passed: false }, "codex");
    expect(proof).toMatchObject({
      testFiles: ["test/math.test.js"],
      check: { command: "node test.mjs", agentRan: { exitCode: 1, outcome: "failed" }, pluginPassed: false },
    });
    expect(proof.claims.map((c) => [c.kind, c.verdict])).toEqual([
      ["fixed", "contradicted"],
      ["tests_pass", "contradicted"],
    ]);
    expect(agentRanCheck(proof.commands, "npm test")).toBeNull();
  });
});

describe("proof labels", async () => {
  const { checkProvenance, claimLine, proofFacts, proofLabel } = await import("../client/format");
  it("summarizes the record in one line each", () => {
    const turn = [user("fix sum"), claudeEdit("test/math.test.js"), claudeBashFailed("node test.mjs", 1), say("All tests pass.")];
    const proof = buildProof(extractEvidence(turn), "node test.mjs", null, "claude");
    expect(proofLabel(proof)).toBe("Claim contradicted");
    expect(claimLine(proof.claims[0]!)).toBe('"tests pass": contradicted, last test command failed: node test.mjs (exit 1)');
    expect(proofFacts(proof)).toBe("1 command, 1 failed · 1 file written (1 test)");
    expect(checkProvenance(proof, "running")).toBe("node test.mjs: agent ran it (exit 1); plugin check pending");
    expect(checkProvenance(proof, "needs_approval")).toBe("node test.mjs: agent ran it (exit 1); plugin check needs approval");
  });

  it("keeps a bare 'done' or 'fixed' with nothing run muted 'not checked', never green", async () => {
    const { overallTone, proofTone } = await import("../client/format");
    const turns = [
      [user("fix sum"), say("Fixed. Done.")],
      [user("fix sum"), claudeEdit("src/math.ts"), say("Fixed. Done.")],
      // An ad-hoc exit 0 backs no claim.
      [user("fix sum"), claudeEdit("src/math.ts"), claudeBashOk("ls src/"), say("Fixed. Done.")],
    ];
    for (const turn of turns) {
      const proof = buildProof(extractEvidence(turn), null, null, "claude");
      expect(proof.claims.map((c) => [c.kind, c.verdict])).toEqual([["fixed", "unchecked"], ["done", "unchecked"]]);
      expect(claimLine(proof.claims[1]!)).toMatch(/^"done": not checked, no matching command ran /);
      expect([proofTone(proof), proofLabel(proof)]).toEqual(["muted", "Claims not checked"]);
      const verify = { state: "skipped" as const, command: null, exitCode: null, durationMs: 0, tail: "", attempt: 0, maxAttempts: 1, note: null };
      const report = {
        id: "r", agentId: "a", agentTitle: "a", workspaceId: "w", turnId: "t", cwd: "/r", branch: "main", startedAt: null, endedAt: "2026-10-17T22:00:00.000Z",
        verify, collisions: { state: "done" as const, peersChecked: 0, items: [], durationMs: 0, note: null }, artifacts: { state: "done" as const, items: [], more: 0, note: null }, proof,
      };
      expect(overallTone(report)).toBe("muted");
      expect(overallTone({ ...report, verify: { ...verify, state: "needs_approval", command: "npm test" } })).toBe("muted");
    }
  });
});

describe("second-pass review fixes", () => {
  const testsPass = matchClaims("All tests pass.");
  const verdictOf = (turn: AgentTimelineItem[], message = "All tests pass.", plugin: { command: string; passed: boolean } | null = null, context?: { root: string; cwd: string }) =>
    judgeClaims(matchClaims(message), extractEvidence(turn, context), plugin).map((c) => [c.kind, c.verdict, c.reason]);

  it("reads an echoed `$?` only when the line prints it in a form it can parse back (review F1)", () => {
    const edit = claudeEdit("src/a.ts");
    // The plain form still works both ways.
    expect(verdictOf([user("go"), edit, claudeBashEcho('npm test; echo "exit: $?"', "FAIL a.test.ts\nexit: 1")])[0]?.[1]).toBe("contradicted");
    expect(verdictOf([user("go"), edit, claudeBashEcho('npm test; echo "exit: $?"', "ok\nexit: 0")])[0]?.[1]).toBe("verified");
    // An echo that does not print the status, or whose line is missing from the output, settles nothing.
    for (const [command, output] of [
      ["npm test; echo done", "FAIL a.test.ts\ndone"],
      ['npm test; echo "exit: $?"', "FAIL a.test.ts"],
      ["npm test; echo", "FAIL a.test.ts\n"],
      ['npm test; echo "finished"', "FAIL a.test.ts\nfinished"],
    ]) {
      expect([command, verdictOf([user("go"), edit, claudeBashEcho(command!, output!)])[0]?.[1]]).toEqual([command, "unsupported"]);
    }
    // Whatever the echo shape, an echoed failure never reads as a pass.
    expect(verdictOf([user("go"), edit, claudeBashEcho('npm test; echo "exit: $?" >&2', "FAIL a.test.ts\nexit: 1")])[0]?.[1]).not.toBe("verified");
  });

  it("applies the same shape rules to the plugin check: a check whose status is not its own is not counted (review N1)", () => {
    const turn = [user("go"), claudeEdit("src/a.ts"), say("All tests pass.")];
    for (const command of ["npm test | tail -5", "npm test || true", "npm test; echo done", "jest --listTests", "cd /tmp/other && npm test"]) {
      const [claim] = judgeClaims(testsPass, extractEvidence(turn), { command, passed: true });
      expect([command, claim?.verdict]).toEqual([command, "unsupported"]);
      expect(claim?.reason).toMatch(/check not counted/);
    }
    // A plain check still decides, both ways.
    expect(judgeClaims(testsPass, extractEvidence(turn), { command: "npm test", passed: true })[0]).toMatchObject({ verdict: "verified", reason: "agent ran none, check passed: npm test" });
    expect(judgeClaims(testsPass, extractEvidence(turn), { command: "npm test", passed: false })[0]?.verdict).toBe("check_failed");
    expect(judgeClaims(testsPass, extractEvidence(turn), { command: "set -o pipefail; npm test | tail -5", passed: false })[0]?.verdict).toBe("check_failed");
    // A failed uncounted check cannot turn the agent's passing run into a disagreement.
    const ran = [user("go"), claudeEdit("src/a.ts"), claudeBashOk("npm test")];
    expect(judgeClaims(testsPass, extractEvidence(ran), { command: "npm test | tail -5", passed: false })[0]?.verdict).toBe("verified");
  });

  it("ends the 'after the last edit' scope at a shell command that writes files (review F6)", () => {
    for (const write of ["sed -i 's/a/b/' src/a.ts", "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF", "git checkout other -- src", "echo x > src/a.ts", "git stash", "cp /tmp/a.ts src/a.ts"]) {
      const turn = [user("go"), claudeEdit("src/a.ts"), claudeBashOk("npm test"), claudeBashOk(write)];
      expect([write, verdictOf(turn)[0]?.[1]]).toEqual([write, "unsupported"]);
    }
    // Reading commands do not.
    for (const read of ["cat src/a.ts", "git status", "git diff", "grep -n a src/a.ts", "ls src"]) {
      const turn = [user("go"), claudeEdit("src/a.ts"), claudeBashOk("npm test"), claudeBashOk(read)];
      expect([read, verdictOf(turn)[0]?.[1]]).toEqual([read, "verified"]);
    }
  });

  it("does not count a run in another directory for this workspace (review F6)", () => {
    const context = { root: "/repo", cwd: "/repo" };
    const edit = claudeEdit("/repo/src/a.ts");
    expect(verdictOf([user("go"), edit, claudeBashOk("cd /tmp/other && npm test")], undefined, null, context)[0]).toEqual([
      "tests_pass",
      "unsupported",
      "no matching command ran after the last edit (in another directory: cd /tmp/other && npm test)",
    ]);
    // Codex reports the directory a command ran in.
    const elsewhere: AgentTimelineItem = { type: "tool_call", callId: "c", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "npm test", cwd: "/other", output: "", exitCode: 0 } };
    expect(verdictOf([user("go"), edit, elsewhere], undefined, null, context)[0]?.[1]).toBe("unsupported");
    const inside: AgentTimelineItem = { ...elsewhere, detail: { type: "shell", command: "npm test", cwd: "/repo/web", output: "", exitCode: 0 } } as AgentTimelineItem;
    expect(verdictOf([user("go"), edit, inside], undefined, null, context)[0]?.[1]).toBe("verified");
    expect(verdictOf([user("go"), edit, claudeBashOk("cd web && npm test")], undefined, null, context)[0]?.[1]).toBe("verified");
    expect(verdictOf([user("go"), edit, claudeBashOk("cd ../other && npm test")], undefined, null, context)[0]?.[1]).toBe("unsupported");
    const ev = extractEvidence([user("go"), edit, claudeBashOk("cd /tmp/other && npm test")], context);
    expect(ev.commands.map((c) => [c.kind, c.outcome])).toEqual([["test", "elsewhere"]]);
  });

  it("keeps each run's kind on a line that runs several (review F9)", () => {
    const turn = [user("go"), claudeEdit("src/a.ts"), claudeBashOk("npm run build && npm test")];
    expect(verdictOf(turn, "The build succeeds. All tests pass.").map(([kind, verdict]) => [kind, verdict])).toEqual([
      ["build_ok", "verified"],
      ["tests_pass", "verified"],
    ]);
    expect(extractEvidence(turn).commands.map((c) => [c.kind, c.exitCode, c.outcome])).toEqual([
      ["build", 0, "ok"],
      ["test", 0, "ok"],
    ]);
    // When the line failed, which run failed is unknown: neither contradicts nor verifies.
    const failed = [user("go"), claudeEdit("src/a.ts"), claudeBashFailed("npm run build && npm test", 1)];
    expect(verdictOf(failed, "The build succeeds. All tests pass.").map(([kind, verdict]) => [kind, verdict])).toEqual([
      ["build_ok", "unsupported"],
      ["tests_pass", "unsupported"],
    ]);
  });

  it("reads a zero count only when it stands alone, and keeps other failure words a negation (review N2)", () => {
    for (const sentence of [
      "Tests pass on Node 20.0 failed on 18.",
      "Build succeeds except v2.0 failed to build.",
      "All tests pass apart from 1.0 failed requests.",
      "Tests pass, no test failed but 3 were skipped and 2 crashed.",
      "Tests pass (fail 0, error 4).",
      "Tests pass, 0 failed, 2 errored.",
      "The build succeeds with 3 errors.",
      "Tests pass but the e2e run broke.",
    ]) {
      expect([sentence, matchClaims(sentence)]).toEqual([sentence, []]);
    }
    for (const sentence of ["Tests pass: 2 passed and 0 failed.", "12 passed, 0 failed.", "All tests pass (0 failing).", "Tests pass: pass 5, fail 0.", "All 5 tests pass, no tests failed.", "Tests pass, failed: 0.", "Tests: 42 passed, 0 failed."]) {
      expect([sentence, matchClaims(sentence).map((c) => c.kind)]).toEqual([sentence, ["tests_pass"]]);
    }
    for (const sentence of ["The build succeeds with 0 errors.", "No type errors.", "Typecheck passes with no errors."]) {
      expect([sentence, matchClaims(sentence).map((c) => c.kind)]).toEqual([sentence, ["build_ok"]]);
    }
    for (const sentence of ["2 passed and 0 failed, but I didn't run the e2e suite.", "Tests pass: 2 passed, 0 failed, 1 failed to compile.", "Tests pass: 10 failed, 0 failed in unit.", "Not all tests pass: 0 failed, 3 errored.", "0 tests failed to run."]) {
      expect([sentence, matchClaims(sentence)]).toEqual([sentence, []]);
    }
  });

  it("finds the claim phrasings it missed, and none in negations or quoted text (review F9)", () => {
    const kinds = (message: string) => matchClaims(message).map((c) => c.kind);
    for (const sentence of ["Tests passed!", "Tests are all passing.", "`npm test` passes.", "The suite is green.", "The test suite is passing.", "`npx vitest run` passed."]) {
      expect([sentence, kinds(sentence)]).toEqual([sentence, ["tests_pass"]]);
    }
    for (const sentence of ["Typecheck passes.", "`npm run build` succeeds.", "`tsc --noEmit` passes."]) {
      expect([sentence, kinds(sentence)]).toEqual([sentence, ["build_ok"]]);
    }
    expect(kinds("Build: OK. Tests: OK.")).toEqual(["build_ok", "tests_pass"]);
    for (const sentence of ["None of the tests pass.", "No tests pass.", "`npm run lint` passes.", 'The issue title is "All tests pass on CI".', "You asked me to make sure “the build succeeds”."]) {
      expect([sentence, kinds(sentence)]).toEqual([sentence, []]);
    }
  });

  it("re-run reads a stored command again with today's rules, so an old false green does not survive (migration)", () => {
    const oldProof = {
      provider: "claude",
      commands: [{ command: "npm test; echo done", kind: "test" as const, exitCode: 0, outcome: "ok" as const, index: 2 }],
      commandsTotal: 1,
      failedTools: [],
      deniedTools: [],
      files: ["src/a.ts"],
      testFiles: [],
      lastEditIndex: 1,
      check: { command: null, agentRan: null, pluginPassed: null },
      claims: [{ kind: "tests_pass" as const, text: "All tests pass.", verdict: "verified" as const, reason: "npm test; echo done passed" }],
    };
    const again = buildProof(evidenceFromProof(oldProof), null, null, "claude");
    expect(again.claims.map((c) => [c.verdict, c.reason])).toEqual([["unsupported", "no matching command ran after the last edit (recorded by an older version: npm test; echo done)"]]);
    expect(again.commands.map((c) => c.outcome)).toEqual(["stale"]);
    // The check runs again on Re-run, and decides; a recorded failure still contradicts.
    expect(buildProof(evidenceFromProof(oldProof), "npm test", { command: "npm test", passed: true }, "claude").claims.map((c) => c.verdict)).toEqual(["verified"]);
    const failedOld = { ...oldProof, commands: [{ command: "npm test", kind: "test" as const, exitCode: 1, outcome: "failed" as const, index: 2 }] };
    expect(buildProof(evidenceFromProof(failedOld), null, null, "claude").claims.map((c) => c.verdict)).toEqual(["contradicted"]);
    // A stored shell write after the test ends the scope too.
    const write = { ...oldProof, commands: [{ ...oldProof.commands[0]!, command: "npm test" }, { command: "sed -i s/a/b/ src/a.ts", kind: "other" as const, exitCode: 0, outcome: "ok" as const, index: 3 }], commandsTotal: 2 };
    expect(buildProof(evidenceFromProof(write), null, null, "claude").claims.map((c) => c.verdict)).toEqual(["unsupported"]);
    // A proof built with today's rules is judged the same on re-run.
    const fresh = buildProof(extractEvidence([user("go"), claudeEdit("src/a.ts"), claudeBashEcho('npm test; echo "exit: $?"', "ok\nexit: 0"), say("All tests pass.")]), null, null, "claude");
    expect(fresh.claims.map((c) => c.verdict)).toEqual(["verified"]);
    expect(buildProof(evidenceFromProof(fresh), null, null, "claude").claims.map((c) => c.verdict)).toEqual(["verified"]);
  });
});
