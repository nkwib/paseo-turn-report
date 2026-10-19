import { describe, expect, it } from "vitest";
import { commandResult, commandShape, type CommandKind } from "../shared/command-kind";

type Expected = readonly [CommandKind, "own" | "unknown", number | null];
/** command, what the call printed, the exit code it reported, and the expected [kind, status, exitCode] of its main run. */
type Case = readonly [string, string | undefined, number | null, Expected];

const check = (cases: readonly Case[]) => {
  const actual = cases.map(([command, output, code]) => {
    const { kind, status, exitCode } = commandResult(command, output, code);
    return [command, output, code, [kind, status, exitCode]];
  });
  expect(actual).toEqual(cases);
};

const FAIL = "FAIL a.test.ts\n1 failed";
const UNKNOWN_TEST: Expected = ["test", "unknown", null];

describe("commandResult: a status the agent echoed with $?", () => {
  it("reads the code from the final line the echo printed", () => {
    check([
      ['npm test; echo "exit: $?"', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test; echo "exit: $?";', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test; echo "exit: $?" >&2', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test; echo -e "exit: $?"', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test; echo "status $? done"', `${FAIL}\nstatus 1 done`, 0, ["test", "own", 1]],
      ['npm test; echo "exit: $?" # rc', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test; echo "exit: $?" 2>&1', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['npm test 2>&1; echo "Exit code: $?"', `${FAIL}\nExit code: 1`, 0, ["test", "own", 1]],
      ['npm test; echo "exit=$? "', `${FAIL}\nexit=1`, 0, ["test", "own", 1]],
      ['{ npm test; } 2>&1; echo "exit: $?"', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ['(npm test); echo "exit: $?"', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ["npm test; echo $?", "FAIL a.test.ts\n2", 0, ["test", "own", 2]],
      // A completed Claude call carries no exit code; the echo still settles it.
      ['node test.mjs; echo "exit: $?"', "all passed\nexit: 0\n", null, ["test", "own", 0]],
      ['set -o pipefail; npm test | tail -5; echo "exit: $?"', `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
      ["bash -c 'npm test; echo \"exit: $?\"'", `${FAIL}\nexit: 1`, 0, ["test", "own", 1]],
    ]);
  });

  it("never falls back to the echo's own exit 0 when the code cannot be read", () => {
    check([
      // No output, empty output, or the echo line missing.
      ['npm test; echo "exit: $?"', undefined, 0, UNKNOWN_TEST],
      ['npm test; echo "exit: $?"', "", 0, UNKNOWN_TEST],
      ['npm test; echo "exit: $?"', FAIL, 0, UNKNOWN_TEST],
      // Only the last line counts: an earlier "exit: 0" is the test's own output.
      ['npm test; echo "exit: $?"', "exit: 0\nFAIL", 0, UNKNOWN_TEST],
      // The echo went to a file, or prints the status twice, or prints other expansions.
      ["npm test; echo $? > /tmp/rc", "FAIL\n0", 0, UNKNOWN_TEST],
      ['npm test; echo "$? $?"', "1 1", 0, UNKNOWN_TEST],
      ['npm test; echo "exit: $? in $PWD"', "exit: 0 in /repo", 0, UNKNOWN_TEST],
      // Single quotes print a literal $?.
      ["npm test; echo 'exit: $?'", "exit: $?", 0, UNKNOWN_TEST],
      // A status read through a pipe is the pipe's, and a later command hides it.
      ['npm test 2>&1 | tail -5; echo "exit: $?"', `${FAIL}\nexit: 0`, 0, UNKNOWN_TEST],
      ['npm test; echo "exit: $?"; echo done', `${FAIL}\nexit: 1\ndone`, 0, UNKNOWN_TEST],
      ['npm test; echo "exit: $?"; true', `${FAIL}\nexit: 0`, 0, UNKNOWN_TEST],
      // The call failed although its last command is an echo: something else ended the line.
      ['npm test; echo "exit: $?"', "exit: 0", 1, UNKNOWN_TEST],
      ['set -e; npm test; echo "exit: $?"', FAIL, 1, UNKNOWN_TEST],
      // Out of range for an exit status.
      ['npm test; echo "exit: $?"', "exit: 999", 0, UNKNOWN_TEST],
    ]);
  });

  it("commandShape alone, with no output, cannot settle an echoed status", () => {
    expect(commandShape('npm test; echo "exit: $?"')).toEqual({ kind: "test", status: "unknown" });
    expect(commandShape("npm test")).toEqual({ kind: "test", status: "own" });
  });
});

describe("commandResult: commands that may not run", () => {
  it("is unknown when control flow can skip the run", () => {
    check([
      ["true || npm test", "", 0, UNKNOWN_TEST],
      ["git diff --quiet || npm test", "", 0, UNKNOWN_TEST],
      ['[ -z "$CI" ] || npm test', "", 0, UNKNOWN_TEST],
      ["test -f .skip || npm test", "", 0, UNKNOWN_TEST],
      ["false && echo x || npm test", "", 0, UNKNOWN_TEST],
      ["true || (cd . && npm test)", "", 0, UNKNOWN_TEST],
      ["true || { npm test; }", "", 0, UNKNOWN_TEST],
      ["true || (echo a; npm test)", "", 0, UNKNOWN_TEST],
      ["if [ -f x ]; then npm test; fi", "", 0, UNKNOWN_TEST],
      ["if npm test; then echo ok; fi", "", 0, UNKNOWN_TEST],
      ["for f in a b; do npm test; done", "", 0, UNKNOWN_TEST],
      ["while false; do npm test; done", "", 0, UNKNOWN_TEST],
      ["npm test --if-present", "", 0, UNKNOWN_TEST],
      // A trap can replace the exit status; a function body runs only when called, any number of times.
      ["trap 'exit 0' EXIT; npm test", "", 0, UNKNOWN_TEST],
      ["trap 'exit 0' ERR\nnpm test", "", 0, UNKNOWN_TEST],
      ["run_tests() { npm test; }", "", 0, UNKNOWN_TEST],
      ["run_tests () { npm test; }; run_tests", "", 0, UNKNOWN_TEST],
      ["function run_tests { npm test; }", "", 0, ["other", "own", 0]],
    ]);
  });

  it("an earlier conditional does not reach past a separator at its level", () => {
    check([
      ["true || echo skipped; npm test", "", 1, ["test", "own", 1]],
      ["(git diff --quiet || echo changed); npm test", "", 1, ["test", "own", 1]],
      ["false && echo x\nnpm test", "", 1, ["test", "own", 1]],
    ]);
  });

  it("an && before or after the run settles it only when the line succeeded", () => {
    check([
      ["npm run build && npm test", "", 0, ["test", "own", 0]],
      ["npm run build && npm test", "", 1, UNKNOWN_TEST],
      ["npm test && npm run lint", "", 0, ["test", "own", 0]],
      ["npm test && npm run lint", "", 2, UNKNOWN_TEST],
      ["set -e; npm run build; npm test", "", 1, UNKNOWN_TEST],
      ["set -e; npm run build; npm test", "", 0, ["test", "own", 0]],
      // errexit that may be on counts as on.
      ["false && set -e; npm run build; npm test", "", 1, UNKNOWN_TEST],
      ["false && set -e; npm run build; npm test", "", 0, ["test", "own", 0]],
      ["git diff --quiet || set -e\nnpm run build; npm test", "", 1, UNKNOWN_TEST],
      // Steps that only set up the shell keep the status the run's.
      ["export CI=1 && npm test", "", 1, ["test", "own", 1]],
      ["npm test && echo ok", "", 1, ["test", "own", 1]],
      ["npm run build; npm test", "", 1, ["test", "own", 1]],
    ]);
  });

  it("lists every run with its own settlement", () => {
    const strip = (command: string, code: number) => commandResult(command, "", code).runs.map(({ kind, status, exitCode }) => [kind, status, exitCode]);
    expect(strip("npm run build && npm test", 0)).toEqual([["build", "own", 0], ["test", "own", 0]]);
    expect(strip("npm run build && npm test", 1)).toEqual([["build", "unknown", null], ["test", "unknown", null]]);
    expect(strip("npm run lint; npm test", 1)).toEqual([["lint", "unknown", null], ["test", "own", 1]]);
    expect(strip("ls", 0)).toEqual([]);
  });

  it("flags that run no tests or build make the command no run at all", () => {
    const none = ["jest --listTests", "jest --showConfig", "vitest list", "npx vitest list", "vitest --version", "npm test -- --help", "pytest --collect-only", "pytest --co -q", "python -m pytest --fixtures", "cargo test --no-run", "cargo build --help", "go test -list . ./...", "make -n test", "make --dry-run build", "make -q test", "tsc --version", "npx tsc --help", "tsc --showConfig", "tsc --listFilesOnly", "npm run build --dry-run", "npx playwright test --list"];
    expect(Object.fromEntries(none.map((command) => [command, commandResult(command, "", 0).kind]))).toEqual(Object.fromEntries(none.map((command) => [command, "other"])));
    expect(Object.fromEntries(none.map((command) => [command, commandResult(command, "", 0).runs]))).toEqual(Object.fromEntries(none.map((command) => [command, []])));
  });
});

describe("commandResult: whose exit status the line reports", () => {
  it("keeps a plain run's status, including with trailing separators and wrappers", () => {
    check([
      ["npm test", "", 1, ["test", "own", 1]],
      ["npm test;", "", 1, ["test", "own", 1]],
      ["npm test\n", "", 1, ["test", "own", 1]],
      ["npm test ; ", "", 1, ["test", "own", 1]],
      ["(npm test)", "", 1, ["test", "own", 1]],
      ["{ npm test; }", "", 1, ["test", "own", 1]],
      ["npm test", "", null, ["test", "own", null]],
      ["make test", "", 0, ["test", "own", 0]],
      ["yarn test --passWithNoTests", "", 0, ["test", "own", 0]],
      ["vitest --run --reporter=dot", "", 0, ["test", "own", 0]],
      ["exec npm test", "", 1, ["test", "own", 1]],
      ["time npm test", "", 1, ["test", "own", 1]],
      ["nohup npm test", "", 1, ["test", "own", 1]],
      ["env CI=1 npm test", "", 1, ["test", "own", 1]],
      ["npm run test:unit", "", 1, ["test", "own", 1]],
      ["node --test", "", 1, ["test", "own", 1]],
      ["go test ./...", "", 1, ["test", "own", 1]],
      ["cargo test", "", 1, ["test", "own", 1]],
      ["bash -lc 'npm test'", "", 1, ["test", "own", 1]],
      ["bash -o pipefail -c 'npm test | tail'", "", 1, ["test", "own", 1]],
      ["bash -eo pipefail -c 'npm test | tail'", "", 1, ["test", "own", 1]],
      ['sh -c "npm test 2>&1"', "", 1, ["test", "own", 1]],
    ]);
  });

  it("is unknown when the status is piped, negated, backgrounded or replaced", () => {
    check([
      ["npm test | cat", "", 0, UNKNOWN_TEST],
      ["npm test > log; cat log", "", 0, UNKNOWN_TEST],
      ["npm test 2>&1 | tee out.txt", "", 0, UNKNOWN_TEST],
      ["npm test || exit 0", "", 0, UNKNOWN_TEST],
      ["npm test; true", "", 0, UNKNOWN_TEST],
      ["(npm test) ; echo", "", 0, UNKNOWN_TEST],
      ["npm test && echo ok || echo fail", "", 0, UNKNOWN_TEST],
      ["pytest -x || :", "", 0, ["test", "unknown", null]],
      ["npm test &", "", 0, UNKNOWN_TEST],
      ["npm test &\nwait", "", 0, UNKNOWN_TEST],
      ["npm test & wait", "", 0, UNKNOWN_TEST],
      ["npm test & wait $!", "", 0, UNKNOWN_TEST],
      ["! npm test", "", 0, UNKNOWN_TEST],
      ["(npm test) | tee log", "", 0, UNKNOWN_TEST],
      ["{ npm test; } | tee log", "", 0, UNKNOWN_TEST],
      ["bash -c 'npm test | tail'", "", 0, UNKNOWN_TEST],
      ["bash -c 'npm test' | tail", "", 0, UNKNOWN_TEST],
      ["npm test || { echo fail; exit 1; }", "", 1, UNKNOWN_TEST],
      ["npm test 2>&1 | tail -5; exit ${PIPESTATUS[0]}", "", 1, UNKNOWN_TEST],
      ["npm test > >(tee log)", "", 1, UNKNOWN_TEST],
    ]);
  });

  it("honours pipefail only in the shell that set it, and only until it is unset", () => {
    check([
      ["set -o pipefail; npm test 2>&1 | tee out.txt", "", 1, ["test", "own", 1]],
      ["set -euo pipefail\nnpx vitest run 2>&1 | tail -5", "", 1, ["test", "own", 1]],
      ["setopt pipefail; npm test | tail", "", 1, ["test", "own", 1]],
      ["(set -o pipefail; npm test | tail)", "", 1, ["test", "own", 1]],
      ["{ set -o pipefail; }; npm test | tail", "", 1, ["test", "own", 1]],
      ["(set -o pipefail); npm test | tail", "", 1, UNKNOWN_TEST],
      ["(set -o pipefail; npm test) | tail", "", 1, UNKNOWN_TEST],
      ["set +o pipefail; npm test | tail", "", 1, UNKNOWN_TEST],
      ["set -o pipefail; set +o pipefail; npm test | tail", "", 1, UNKNOWN_TEST],
      ["set -o pipefail; unsetopt pipefail; npm test | tail", "", 1, UNKNOWN_TEST],
      ["npm test | tail; set -o pipefail", "", 1, UNKNOWN_TEST],
      // A setting that may have been skipped, or that ran in a pipeline's child shell, is not in effect.
      ["false && set -o pipefail; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["git diff --quiet || set -o pipefail; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["printf '' | set -o pipefail; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["set -o pipefail | cat; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["{ set -o pipefail; true; } | cat; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["set -o pipefail; false && set +o pipefail; npm test | tail -5", "", 0, UNKNOWN_TEST],
      ["true && set -o pipefail; npm test | tail -5", "", 1, ["test", "own", 1]],
      ["set -o pipefail && npm test | tail -5", "", 1, ["test", "own", 1]],
      ["{ set -o pipefail; npm test | tail -5; } | cat", "", 1, UNKNOWN_TEST],
      // Under pipefail a later stage that can fail by itself shares the status.
      ["set -o pipefail; npm test | grep PASS", "", 1, UNKNOWN_TEST],
      ["set -o pipefail; npm test | grep PASS", "", 0, ["test", "own", 0]],
    ]);
  });

  it("does not count commands that only mention a test", () => {
    check([
      ["echo $(npm test)", "", 0, ["other", "own", 0]],
      ["x=$(npm test)", "", 0, ["other", "own", 0]],
      ["ls | xargs npm test", "", 0, ["other", "own", 0]],
      ["bash <<< 'npm test'", "", 0, ["other", "own", 0]],
      ['git commit -m "npm test"', "", 0, ["other", "own", 0]],
    ]);
  });
});

describe("commandResult: the directory a run executes in", () => {
  const where = (command: string) => {
    const { kind, status, cwd } = commandResult(command, "", 0);
    return [kind, status, cwd];
  };
  it("reports a changed directory as written, for the caller to resolve", () => {
    const cases: [string, unknown[]][] = [
      ["npm test", ["test", "own", null]],
      ["cd web && npm test", ["test", "own", "web"]],
      ["cd /tmp/other-worktree && npm test", ["test", "own", "/tmp/other-worktree"]],
      ["cd web; npm test", ["test", "own", "web"]],
      ["cd a && cd b && npm test", ["test", "own", "a/b"]],
      ["cd a && cd /x && npm test", ["test", "own", "/x"]],
      ["pushd web && npm test", ["test", "own", "web"]],
      ["(cd web && npx vitest run)", ["test", "own", "web"]],
      ["(cd web); npm test", ["test", "own", null]],
      ["{ cd web; }; npm test", ["test", "own", "web"]],
      ["bash -c 'cd web && npm test'", ["test", "own", "web"]],
      ["cd web && bash -c 'cd sub && npm test'", ["test", "own", "web/sub"]],
      ["npm --prefix web run test:unit", ["test", "own", "web"]],
      ["npm test --prefix=web", ["test", "own", "web"]],
      ["pnpm -C web test", ["test", "own", "web"]],
      ["pnpm --dir web test", ["test", "own", "web"]],
      ["yarn --cwd web test", ["test", "own", "web"]],
      ["make -C sub test", ["test", "own", "sub"]],
      ["env -C sub npm test", ["test", "own", "sub"]],
      ["go -C sub test ./...", ["test", "own", "sub"]],
      ["cargo test --manifest-path sub/Cargo.toml", ["test", "own", "sub"]],
      ["npm test; cd ..", ["test", "unknown", null]],
    ];
    expect(cases.map(([command]) => [command, where(command)])).toEqual(cases);
  });

  it("is unknown when the directory or package cannot be established", () => {
    const cases = ["test -d web && cd web; npm test", "git diff --quiet || cd web; npm test", "ls | cd web; npm test", "cd web | true; npm test", "{ cd web; } | cat; npm test", "cd && npm test", "cd ~ && npm test", "cd ~/repo && npm test", "cd - && npm test", "cd $DIR && npm test", 'cd "$(git rev-parse --show-toplevel)" && npm test', "popd && npm test", "pnpm --filter api test", "pnpm -F api test", "pnpm -r test", "yarn workspace api test", "npm -w api test", "npm test --workspace=api", "npm test --workspaces"];
    expect(cases.map((command) => [command, commandResult(command, "", 0).status])).toEqual(cases.map((command) => [command, "unknown"]));
  });

  it("gives each run its own directory", () => {
    const runs = commandResult("(cd /tmp/x && npm run build) && npm test", "", 0).runs.map(({ kind, cwd }) => [kind, cwd]);
    expect(runs).toEqual([["build", "/tmp/x"], ["test", null]]);
  });

  it("commandShape treats any changed directory as unknown, having no root to check it against", () => {
    expect(commandShape("cd web && npm test")).toEqual({ kind: "test", status: "unknown" });
    expect(commandShape("npm --prefix web test")).toEqual({ kind: "test", status: "unknown" });
  });
});

describe("commandResult: writes", () => {
  const writes = (command: string) => commandResult(command, "", 0).writes;
  it("is true for any command that may change files", () => {
    const yes = ["sed -i '' 's/a/b/' src/a.ts", "sed -Ei 's/a/b/' a", "perl -pi -e 's/a/b/' a", "cat > src/b.ts <<'EOF'\nbroken\nEOF", "echo x >> a.ts", "echo x &> a.ts", "git checkout other -- src", "git restore src", "git stash pop", "git apply p.diff", "git switch main", "git reset --hard", "git merge x", "git rebase main", "git pull", "git cherry-pick abc", "git revert abc", "git clean -fd", "git mv a b", "git rm a", "cp a b", "mv a b", "rm -rf dist", "touch a", "mkdir -p a", "patch -p1 < p.diff", "npm install", "pnpm add -D vitest", "printf x | tee a.ts", "find . -name '*.orig' -delete", "find . -exec rm {} +", "node -e 'require(\"fs\").writeFileSync(\"a\",\"b\")'", "python3 fix.py", "./scripts/gen.sh", "bash -c 'echo x > a'", "eslint --fix .", "prettier --write .", "sort -o a a", "ls | xargs rm", "echo $(sed -i s/a/b/ a)", "git -C sub checkout main", "npm test > report.txt"];
    expect(Object.fromEntries(yes.map((command) => [command, writes(command)]))).toEqual(Object.fromEntries(yes.map((command) => [command, true])));
  });
  it("is false for reads and for the runs themselves", () => {
    const no = ["ls -la", "cat src/a.ts", "sed -n '1,40p' a.ts", "rg -n foo src", "grep -r x . 2>/dev/null", "git status", "git diff --stat", "git log --oneline -5", "git show HEAD:a.ts", "git branch --show-current", "git add -A", "git commit -am x", "npm test && git commit -am x", "git push", "git fetch origin", "git tag v1", "git branch -D old", "find . -name '*.ts'", "head -5 a | wc -l", "npm test", "npm run build && npm test 2>&1 | tail -5", "npx vitest run", "cd web && npm test", 'npm test; echo "exit: $?"', "npm ls vitest", "jest --listTests", "echo done", "pwd", "export CI=1", "eslint ."];
    expect(Object.fromEntries(no.map((command) => [command, writes(command)]))).toEqual(Object.fromEntries(no.map((command) => [command, false])));
  });
});
