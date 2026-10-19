/**
 * Variables Paseo strips before it starts any external process (RUNTIME_CONTROL_ENV_KEYS, paseo-env.ts): with
 * ELECTRON_RUN_AS_NODE set by the desktop app, an Electron binary run by a check would start as plain Node.
 */
const RUNTIME_CONTROL_ENV_KEYS = ["PASEO_NODE_ENV", "PASEO_DESKTOP_MANAGED", "PASEO_SUPERVISED", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ESBUILD_BINARY_PATH"];

/** The daemon's env without its runtime-control variables and without PASEO_* (PASEO_PASSWORD among them): project code never needs them. */
export function externalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith("PASEO_") || RUNTIME_CONTROL_ENV_KEYS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}
