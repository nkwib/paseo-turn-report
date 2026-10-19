// Validate a clean plugin tree with the selected host's compiler, manifest reader and server evaluator.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [compilerDir, paseoPlugins, pluginDir, outDir] = process.argv.slice(2);
const finish = (result) => writeFileSync(join(outDir, "result.json"), JSON.stringify(result));
const hostModule = (directory, name) => pathToFileURL(join(directory, `${name}.${existsSync(join(directory, `${name}.js`)) ? "js" : "ts"}`)).href;

try {
  const { compilePlugin } = await import(hostModule(compilerDir, "compiler"));
  const { readPluginManifest } = await import(hostModule(paseoPlugins, "manifest"));
  const { evaluateBundle } = await import(hostModule(paseoPlugins, "bundle-evaluator"));
  await readPluginManifest(pluginDir);
  const { clientBundle, serverBundle } = await compilePlugin({ client: join(pluginDir, "index.client.tsx"), server: join(pluginDir, "index.server.ts") });
  const handlers = [];
  const hooks = [];
  const settings = [];
  const cleanup = evaluateBundle(serverBundle)({
    registerSettings: (definition) => {
      settings.push(definition.id);
      return { read: async () => ({ status: "invalid", revision: "", error: "test" }), subscribe: () => () => {} };
    },
    on: (name) => {
      hooks.push(name);
      return () => {};
    },
    handle: (contract) => void handlers.push(contract.name),
  });
  await cleanup?.();
  finish({ clientBytes: clientBundle?.length ?? 0, serverBytes: serverBundle?.length ?? 0, handlers, hooks, settings });
} catch (error) {
  finish({ error: error instanceof Error ? error.message : String(error) });
}
