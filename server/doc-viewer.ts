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
