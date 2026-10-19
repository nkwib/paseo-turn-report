import { describe, expect, it } from "vitest";
import { shellSegments } from "../shared/shell";

const shape = (command: string) => shellSegments(command).map(({ argv, next }) => [argv.join(" "), next]);

describe("shellSegments", () => {
  it("splits on &&, ||, ;, |, & and new lines, dropping redirections", () => {
    expect(shape('cd web && CI=1 npx vitest run 2>&1 | tail -5; echo "exit: $?"')).toEqual([
      ["cd web", "&&"],
      ["CI=1 npx vitest run", "|"],
      ["tail -5", ";"],
      ["echo exit: $?", null],
    ]);
    expect(shape("npm test >out.log 2>/dev/null || true\nnpm run lint &> lint.log &")).toEqual([
      ["npm test", "||"],
      ["true", ";"],
      ["npm run lint", "&"],
    ]);
  });

  it("keeps quoted operators, $(...) and backticks inside a word, and skips comments", () => {
    expect(shape(`git commit -m "fix: a && b | c" # npm test`)).toEqual([["git commit -m fix: a && b | c", null]]);
    expect(shape("echo $(npm test; true) `ls | wc -l`")).toEqual([["echo $(npm test; true) `ls | wc -l`", null]]);
  });

  it("skips heredoc bodies and keeps the operator after a group on its last command", () => {
    expect(shape(".venv/bin/python - <<'PY'\nimport subprocess; subprocess.run('npm test')\nPY\nls")).toEqual([
      [".venv/bin/python -", ";"],
      ["ls", null],
    ]);
    expect(shape("(cd web && npm test) | tee log")).toEqual([
      ["cd web", "&&"],
      ["npm test", "|"],
      ["tee log", null],
    ]);
  });

  it("drops a trailing separator, so `npm test;` ends the line", () => {
    expect(shape("npm test;")).toEqual([["npm test", null]]);
    expect(shape("npm test\n")).toEqual([["npm test", null]]);
    expect(shape("npm test ;  # done\n")).toEqual([["npm test", null]]);
    expect(shape("(npm test)")).toEqual([["npm test", null]]);
    expect(shape("npm test &")).toEqual([["npm test", "&"]]);
  });

  it("records subshell and brace-group scopes, and drops the braces", () => {
    const scopes = (command: string) => shellSegments(command).map(({ argv, scope }) => [argv.join(" "), scope.map((id) => (id > 0 ? "(" : "{"))]);
    expect(scopes("(set -o pipefail); npm test")).toEqual([["set -o pipefail", ["("]], ["npm test", []]]);
    expect(scopes("{ npm test; } 2>&1; echo $?")).toEqual([["npm test", ["{"]], ["echo $?", []]]);
    expect(scopes("a || (b && { c; })")).toEqual([["a", []], ["b", ["("]], ["c", ["(", "{"]]]);
    expect(shape("{ npm test; } | tee log")).toEqual([["npm test", "|"], ["tee log", null]]);
    expect(shape("echo { }")).toEqual([["echo { }", null]]);
  });

  it("keeps output redirections with their descriptor", () => {
    const outputs = (command: string) => shellSegments(command).map(({ outputs }) => outputs);
    expect(outputs("npm test >out.log 2>/dev/null >&2 <in")).toEqual([[{ fd: "1", target: "out.log" }, { fd: "2", target: "/dev/null" }]]);
    expect(outputs("echo x >> a &> b 1>c")).toEqual([[{ fd: "1", target: "a" }, { fd: "&", target: "b" }, { fd: "1", target: "c" }]]);
    expect(outputs("cat > a.ts <<'EOF'\nbody\nEOF")).toEqual([[{ fd: "1", target: "a.ts" }]]);
    expect(outputs("{ npm test; } > log")).toEqual([[{ fd: "1", target: "log" }]]);
  });
});
