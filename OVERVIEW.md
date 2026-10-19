Turn report adds one card to an agent's timeline when its turn ends. The card answers three questions without reading the whole transcript: does the project check pass, do the agent's claims match what it actually ran, and will this agent's changes conflict with another agent working in the same repository. It also lists the documents the turn changed. A board in the sidebar shows the latest report for every agent on the host, so you can see which agents need attention.

It is meant for running several coding agents at once, each in its own Git worktree. Everything runs on the machine with your Paseo daemon, and the plugin itself makes no network requests.

## Setup

Requires Paseo 0.11.2 or later, and Git 2.38 or later on the daemon host for conflict detection. The check needs a daemon on macOS or Linux; on Windows it does not run and the card says checks need macOS or Linux. The other sections work on every platform.

The check needs a command. Set "Check command" in Settings, Turn report, or add `scripts.verify`, `scripts.check` or `scripts.test` to the workspace's `paseo.json`. The setting wins when both exist. Without either, the card says there is no check, names both places, and the other sections still work.

A command found in `paseo.json` does not run until you approve it, because an agent can edit that file. Until then the card reads "Check needs approval" and shows the command with a "Run this check after each turn" button, on the card and on the board. Approval covers that exact command text in that workspace: when the text changes, the card asks again. A command with control, zero-width or bidirectional characters is shown with those characters escaped and cannot be approved. The "Check command" setting runs without approval, because you typed it there.

Approval pins the command text, not what it runs. An approved `npm test` or `node test.mjs` runs whatever `package.json` and the test files contain at that moment, including code the agent just wrote. The check runs that project code after every turn as the daemon's user, outside any agent sandbox, with that user's files and network. The setting behaves the same way.

## The card

A turn that completes gets a card. A turn with no shell command, no claim and no changed file (a chat-only turn) gets none, and neither does a canceled or failed turn. The top line has a chip for each section, and a proof chip when a claim needs attention.

- **Check.** The plugin runs the check in the repository root with `/bin/sh`, as the daemon's user, in its own process group. Its environment is the daemon's, plus `CI=1` and `FORCE_COLOR=0`, minus the variables Paseo removes before it starts any external process (such as `ELECTRON_RUN_AS_NODE`) and minus every `PASEO_*` variable, `PASEO_PASSWORD` included. The card shows the command, where it came from, the exit code, the duration and the last 2,000 characters of output, with Show output, Copy output and Re-run. The check ends when its shell exits; whatever it left running in its process group (a server started with `&`) is stopped then. A check that runs longer than "Stop the check after" (10 minutes by default) is stopped with its whole process group, and so is a running check when the plugin stops or reloads. Only one check runs per agent at a time: a turn that ends while the previous check still runs reads "Check busy".
- **Proof.** The plugin reads the claims in the agent's final message ("tests pass", "build ok", "verified", "fixed", "done") and judges each against every command the agent ran after its last file edit, and against the plugin's check:
  - "contradicted" (red): the agent's last matching command failed.
  - "agent and check disagree" (amber): the agent's run passed and the plugin's check failed.
  - "check failed after claim" (amber): the plugin's check failed and the agent ran nothing that settles it.
  - "unverified" (amber): "tests pass", "build ok" or "verified" with no matching command and no matching check.
  - "verified" (green): a matching command passed, or the plugin's check passed.
  - "checked by the agent" (muted): "verified" backed only by some other command the agent ran that exited 0, with no failed command after it.
  - "not checked" (muted): "fixed" or "done" with nothing run and no check. A bare "done" never reads green on its own.

  A test claim needs a test command, a build claim a build command, and "verified", "fixed" and "done" accept a test, build or lint command. For those three, the last run of each kind after the last edit counts: if any of them failed, the claim is contradicted, whatever passed after it. The plugin's check counts for a claim the same way: a lint check does not verify "tests pass", and a check the plugin cannot classify (`make ci`, `./check.sh`) settles no claim.

  A command is classified by the program each part of it runs. The line is split at `&&`, `||`, `;`, `|` and new lines, and environment assignments, prefixes such as `timeout 60`, and runners such as `npx`, `pnpm exec`, `yarn`, `bunx`, `uv run`, `poetry run` and `python -m` are skipped, so `cd web && npx vitest run` is a test run and `cat test.mjs` or `rg -n jest` is not. Known programs and scripts are recognized (vitest, jest, pytest, `cargo test`, `go test`, `npm test` and `test:*` scripts, tsc, eslint, ruff, a script named like `test.mjs`, and similar). A test, build or lint run whose exit status the line does not return reads "exit unknown" and is not evidence either way: piped into another command without `set -o pipefail` (`npx vitest run | tail -5`), followed by `||`, sent to the background with `&`, or followed by more commands. When an agent ends a command with `echo "exit: $?"`, the plugin reads the echoed status. A command you denied never settles a claim and does not count as a failure. A command the agent moved to the background is not evidence either way, unless a later tool call in the same turn reports its exit status. The section also counts the turn's commands, failures and denials (shell and other tools), lists the last commands with their exit codes, shows a count of the files written, lists any test files edited, and says whether the agent ran the configured check itself.
- **Collisions.** The plugin compares this agent's worktree with the worktrees of other live agents in the same repository, up to 8, and lists the files that would conflict if both were merged, with the kind of conflict (content, add/add, modify/delete). It compares the current state of each worktree, including uncommitted and untracked files, not just committed branches. The other agent's latest report is updated too, so both sides show the conflict. In a workspace that is not a Git repository the chip reads "Collisions need a git repository".
- **Documents.** PDF, Word, Excel, CSV, PowerPoint, image, JSON Lines and Jupyter notebook files modified during the turn, newest first, up to 12, marked new or changed, with a copy path button. When the [PDF and Office viewer](https://github.com/nkwib/paseo-doc-viewer) plugin is enabled, the chat card shows only the count, because the viewer adds its own card for the same files, and the board lists them with Open for the types the viewer renders (not SVG or notebooks).

Re-run repeats the check, the conflict check and the document scan for a stored report, using the original turn's time window, and replaces the card. A second Re-run or approval of a report while it is being redone starts nothing new, and the approve button stays disabled until the request returns.

## Board

The Turn reports item in the sidebar footer shows the most urgent count that is not zero ("2 red", "1 amber", "3 unchecked" or "4 green") and opens the board. The board fetches all kept reports and lists the latest report per agent, or every turn with History, each colored by the worst of its check, collisions and proof: a contradicted claim makes it red, an amber proof or a conflict makes it at least amber. Tap a row to see the full report and open a colliding agent. The same board is a workspace panel, limited to that workspace unless you turn on All workspaces, and the Command Center has "Open turn reports" and "Open turn report board". Open boards refresh every 4 seconds.

## Settings

Settings, Turn report, applies to the host and is shared by every client:

- Run the project check when a turn ends: on by default.
- Check command: empty by default, which means `paseo.json` (with approval).
- Stop the check after: 10 minutes by default.
- Send failures back to the agent, at most: "Never send" by default, or 1, 2, 3 or 5 times. See below.
- Check conflicts with other live agents: on by default.
- List documents changed during the turn: on by default.
- Open documents with plugin: the plugin id that opens documents, `paseo-doc-viewer` by default. Empty shows copy buttons only.

## Messages sent to agents

By default the plugin never sends anything to an agent. When "Send failures back to the agent" is above zero and the check fails, the plugin sends the agent one message with the command, its exit code and the last 2,000 characters of output, and asks it to fix the cause. It sends only if the agent is idle right before sending, and the card says "not sent" otherwise. One gap remains: if a turn starts in the moment between that check and the send, the daemon adds the message to the running turn on providers that can steer, and replaces the turn on the others. After the set number of failed checks in a row it stops and the card says it gave up. The message becomes part of that agent's conversation and reaches the agent's model provider, so anything your check prints, including secrets, goes with it.

## What it reads and runs

- The agent's conversation, which Paseo passes to the plugin when a turn ends. The plugin keeps only facts from the current turn.
- The host's agent list (titles, working directories, status), to find live agents in the same repository.
- The daemon configuration, read from the app, to tell whether the document viewer plugin is enabled. Only its plugin entries are used.
- The workspace's `paseo.json`, file names, sizes and times in the workspace, and `git status`. The document scan reads no file contents.
- Git, run on the daemon host with prompts, pagers, optional locks, lazy fetching and the fsmonitor hook turned off, with the same environment cleanup as the check, and without variables such as `GIT_DIR` that would point it at another repository. On the repository itself it runs `rev-parse`, `config` (to read the object format and four filesystem settings) and `status`. For conflicts it runs `read-tree`, `add`, `write-tree`, `commit-tree` and `merge-tree` against a private repository under the system temp directory (`turn-report-*`): its own config and index, the repository's objects read through alternates, and a copy of `info/exclude`. The repository's `.git/config` is not read there, so a filter or merge driver it names never runs; a driver named in `.gitattributes` falls back to Git's built-in behavior. Your global and system Git configuration still apply. The private repository is deleted afterwards. The plugin never writes to your worktrees, their index, branches or the repository's objects.
- The check command, as described above. It runs project code, including code the agent just wrote, and can do anything the daemon's user can.
- Approving a `paseo.json` check goes through a plugin RPC, which any client connected to the daemon can call. The plugin offers it on the card and on the board.

## What it stores

Reports are stored on the daemon host in `$PASEO_HOME/plugin-data/turn-report` when the daemon's environment sets `PASEO_HOME`, otherwise in `paseo-turn-report` under `$XDG_STATE_HOME` (`~/.local/state` by default). The folder is readable only by the daemon's user. If it is a symlink or belongs to another user, the plugin keeps reports and approvals in memory only. `reports.json` keeps the last 200 reports, so the board survives restarts. A report holds the agent's id, title and provider, the workspace id, the repository path and branch, the check command, exit code and last 2,000 characters of output, conflicting file paths and the other agents' titles, document paths and sizes, up to 12 of the turn's shell commands in full (the ones the verdicts rest on, then the latest), up to 20 written file paths and any test files edited, the names and file paths of denied tools, the first line of failed tool errors, and each claim sentence (up to 90 characters) with its verdict and reason. A file the plugin cannot read, or one written by a newer version, is moved aside (`reports.json.bad`, or a name with its version such as `reports.json.v3`) before a new one is written. Check approvals are kept in `check-approvals.json` in the same folder, as salted hashes of the workspace path and the command, up to 200. To clear everything, delete the folder while the daemon is stopped.

The cards themselves live in the agent's timeline, which Paseo keeps in the daemon's memory, so they disappear from the chat after a daemon restart. The board keeps them.

## Limits

- `git status` runs on the repository itself, as Paseo's own Changes view does, so a clean or process filter named in the repository's config can run when Git rereads a file. An agent can write that config. The conflict check does not read it.
- Changed files come from `git status` entries modified during the turn, plus the files the agent's edit tools report. Git sees every change in that window, not only this agent's: a change by you, by another agent in the same worktree, or a file the previous turn's check wrote counts as this turn's, and can give a chat-only turn a card. The documents list has the same limit.
- Denials by Claude Code and OpenCode are recognized by Paseo's standard deny messages. A denial with a custom message reads as a failed command, which can mark a claim contradicted. Codex marks denials explicitly.
- Claims are matched in English, in the agent's final message only, one per kind. Sentences that hedge, negate or plan ("should pass", "not fixed", "won't", "haven't run") are ignored; a zero count such as "0 failed" is not a negation.
- A claim about some tests ("unit tests pass") is judged against the last test command of any scope: a failing `npm test` that also runs end-to-end tests contradicts it.
- A test script with an unusual name (`node smoke.mjs`, `./ci.sh`) counts as an "other" command, which settles only "verified", and only as "checked by the agent". A check command of that kind settles no claim.
- A process the check starts in a new session leaves its process group: it keeps running after the check ends or times out, though the check no longer waits for it.
- The turn is cut from the conversation by position, because timeline items carry no time. For the first turn after the plugin starts it begins at the last user message. A turn already running when the plugin started gets no document list.
- Conflicts are checked only between worktrees of the same repository. Agents sharing one worktree are not compared with each other.
- Opening documents from the native mobile apps has not been tested.
