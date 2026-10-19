import { describe, expect, it } from "vitest";
import { shellSegments } from "../server/shell";

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
});
