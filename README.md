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

`test/install.test.ts` compiles a `git archive` of `HEAD`, with no `node_modules`, using Paseo's own plugin compiler at the manifest's minimum version and at v0.11.4 (`PASEO_REFS` overrides the list). It needs a getpaseo/paseo checkout with `node_modules` installed, found through `PASEO_SOURCE` or next to this repository as `paseo-main`, and is skipped with that reason otherwise.

## License

MIT. See [LICENSE](LICENSE).
