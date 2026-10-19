# Changelog

## 0.1.1 (unreleased)

### Fixed

- Stop treating masked shell exits, skipped commands and nonexecuting test/build flags as proof that checks passed. Agent commands and the project check now use the same conservative evidence rules.
- Invalidate stale verification after shell writes and reject evidence from another directory. An unrelated successful command no longer supports a verification claim.
- Recognize ordinary passing-test summaries while rejecting mixed failure statements and negative claims.
- Prevent passive Git inspection from running configured filters or hooks, including artifact discovery.
- Invalidate older passing proof judgments when loading saved reports.
- Validate clean Git archives against the released Paseo 0.11.2, 0.11.4 and 0.12.0 hosts in CI. Required host validation fails instead of silently skipping.

## 0.1.0 (2026-10-19)

First public release.

### New

- Turn card: when an agent turn completes, the agent's timeline gets one card with the project check, the agent's claims, merge conflicts with other live agents and the documents changed during the turn. A turn with no shell command, no claim and no changed file gets no card. Canceled and failed turns get none.
- Project check: runs the "Check command" setting, or `scripts.verify`, `scripts.check` or `scripts.test` from the workspace's `paseo.json`, in the repository root after each turn, with a 10 minute timeout. The card shows the exit code, the duration and the last 2,000 characters of output. The check ends when its shell exits and stops what it left in its process group; it is also stopped on timeout and when the plugin stops or reloads. It runs without the daemon's runtime-control variables and without `PASEO_*`. It needs macOS or Linux; on Windows the card says so.
- Approval for `paseo.json` checks: a command found in `paseo.json` runs only after you approve that exact command text for that workspace, from the card or the board. A changed command needs a new approval, and a command with control, zero-width or bidirectional characters is shown escaped and cannot be approved. Until then the check reads "needs approval". The "Check command" setting runs without approval, because you typed it. Approval pins the text, not what the command runs.
- Proof: claims in the agent's final message ("tests pass", "build ok", "verified", "fixed", "done") are judged against every command the agent ran after its last edit and against the plugin's check, when the check is of a kind the claim accepts. Commands are classified by the program each part of the line runs; a check piped or chained away from its exit status reads "exit unknown". Verdicts: verified, checked by the agent, not checked, unverified, check failed after claim, agent and check disagree, contradicted.
- Collisions: each turn compares this agent's worktree with the worktrees of other live agents in the same repository using `git merge-tree`, including uncommitted and untracked files, and lists the files that would conflict. The comparison runs in a private repository, so no filter, merge driver or fsmonitor hook from the repository's config runs. The other agent's latest card is updated too.
- Documents: PDF, Word, Excel, CSV, PowerPoint, image, JSON Lines and notebook files changed during the turn, marked new or changed. Open sends them to the PDF and Office viewer plugin when it is enabled.
- Board: a sidebar item, a screen and a workspace panel show the latest report per agent (or every turn with History), colored by the worst of check, collisions and proof. The sidebar item shows the most urgent count. The last 200 reports are kept on disk, survive restarts and all show on the board.
- Optional auto-retry: "Send failures back to the agent" sends a failed check's output to the idle agent, up to 5 times. Off by default.
- Re-run: repeats the check, collisions and the document scan for a stored report.
