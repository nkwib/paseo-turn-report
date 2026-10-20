import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DocViewerCard } from "../shared/report";
import type { PaseoApi } from "./host-types";

type DaemonConfig = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];

/**
 * The daemon starts a plugin only while plugins are on (an omitted pluginsEnabled is off) and its entry is not disabled
 * (packages/server/src/server/plugins/index.ts). A plugin can read the config, not which plugins are running.
 */
export function enabledInConfig(config: Pick<DaemonConfig, "pluginsEnabled" | "plugins">, pluginId: string): boolean {
  const entry = config.plugins?.[pluginId];
  return config.pluginsEnabled === true && entry !== undefined && entry.enabled !== false;
}

/** The daemon's home as the daemon resolves it (paseo-home.ts); plugin processes inherit its environment. */
export function paseoHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  return resolve(raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);
}

const VIEWER_SETTINGS = { id: "viewer", version: 1 };

/**
 * The viewer's "turnCards" host setting, read from the file the daemon keeps it in
 * ($PASEO_HOME/plugin-settings/<plugin id>/<settings id>.json, plugins/settings/index.ts): one plugin cannot call another's
 * settings RPC. No file means the defaults (on), but only beside the daemon's config.json, so a wrong home is not read as
 * on. Anything else it cannot read is off: documents stay listed here.
 */
export async function turnCardsOn(pluginId: string, home: string): Promise<boolean> {
  if (!(await access(join(home, "config.json")).then(() => true, () => false))) return false;
  let raw: string;
  try {
    raw = await readFile(join(home, "plugin-settings", pluginId, `${VIEWER_SETTINGS.id}.json`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const { version, values } = JSON.parse(raw);
    if (version !== VIEWER_SETTINGS.version || typeof values !== "object" || values === null) return false;
    return values.turnCards === undefined || values.turnCards === true;
  } catch {
    return false;
  }
}

/** The directory the viewer scans for a workspace (paseo-doc-viewer server/paths.ts, workspaceRoot). */
export async function workspaceRoot(paseo: PaseoApi, workspaceId: string): Promise<string | null> {
  const { entries } = await paseo.workspaces.list({ filter: { query: workspaceId }, page: { limit: 200 } });
  const workspace = entries.find((entry) => entry.id === workspaceId);
  const directory = workspace?.workspaceDirectory || workspace?.projectRootPath;
  return directory ? realpath(directory).catch(() => null) : null;
}

export interface DocViewerProbe {
  /** At turn start: the viewer is enabled and the agent has a workspace, so the viewer starts tracking the turn. */
  turnStarted(paseo: PaseoApi, pluginId: string, workspaceId: string | null): Promise<DocViewerCard | null>;
  /** At turn end: still enabled, with turn cards on, so the viewer adds a card for the turn. */
  turnEnded(paseo: PaseoApi, card: DocViewerCard): Promise<boolean>;
}

export function createDocViewerProbe(home = paseoHome()): DocViewerProbe {
  const enabled = async (paseo: PaseoApi, pluginId: string) => enabledInConfig((await paseo.config.get()).config, pluginId);
  return {
    async turnStarted(paseo, pluginId, workspaceId) {
      if (!pluginId || !workspaceId || !(await enabled(paseo, pluginId))) return null;
      const root = await workspaceRoot(paseo, workspaceId);
      return root ? { pluginId, root } : null;
    },
    async turnEnded(paseo, card) {
      return (await enabled(paseo, card.pluginId)) && (await turnCardsOn(card.pluginId, home));
    },
  };
}
