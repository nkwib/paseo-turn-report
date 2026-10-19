# Turn report for Paseo

A [Paseo](https://github.com/getpaseo/paseo) plugin that adds one card to an agent's timeline when its turn ends. The card runs the project check, compares what the agent claims ("tests pass", "verified", "fixed") with the commands it actually ran, lists files that would conflict with other live agents' worktrees, and lists the documents the turn changed. A board in the sidebar shows the latest report for every agent on the host. [OVERVIEW.md](OVERVIEW.md) describes what users see, what the plugin reads and writes, and its limits.

## Install

Requires Paseo 0.11.2 or later with plugins enabled. Conflict detection needs Git 2.38 or later on the daemon host. The project check needs a macOS or Linux daemon.

```sh
paseo plugin install git:nkwib/paseo-turn-report
```

Plugins run unsandboxed on the daemon host. Read the code before you install it.

The plugin has no runtime dependencies beyond the libraries Paseo provides, so installation runs no build step.

## Configure the check

Set "Check command" in Settings, Turn report, or add a script to the workspace's `paseo.json`:

```json
{ "scripts": { "test": { "command": "npm test" } } }
```

The plugin uses `scripts.verify`, then `scripts.check`, then `scripts.test`. A command from `paseo.json` runs only after you approve it from the card or the board, because an agent can edit that file. The setting runs without approval.

Approval pins the command text, not what it runs. The check runs project code, including code the agent just wrote, as the daemon's user and outside any agent sandbox.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests create temporary Git repositories, so they need `git` 2.38 or later on `PATH`.

CI compiles a clean `git archive` of `HEAD`, with no `node_modules`, against the released Paseo 0.11.2, 0.11.4 and 0.12.0 compilers. It also reads the manifest and evaluates the server contribution with each host's own runtime. Missing host validation fails those jobs.

Run the same check locally with an installed Paseo CLI prefix:

```sh
PASEO_RUNTIME=/path/to/paseo-prefix PASEO_REQUIRE_INSTALL=1 npm test -- test/install.test.ts
```

For development builds, set `PASEO_SOURCE` to a dependency-ready getpaseo/paseo checkout. The test always compiles that checkout; `PASEO_REFS=v0.11.2,v0.11.4,v0.12.0` additionally selects compiler refs that must exist in it. Without either host variable, the ordinary test run skips host validation and states why. Invalid explicit host paths and missing requested refs fail rather than skip. Commit changes before this check: it validates `HEAD`, not uncommitted files.

## License

MIT. See [LICENSE](LICENSE).
