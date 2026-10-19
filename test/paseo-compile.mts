// Compiles a plugin folder with Paseo's own compiler, then evaluates the server bundle with Paseo's own evaluator.
// Run with a Paseo checkout's tsx (NODE_PATH pointing at its node_modules when the compiler is extracted from a tag):
//   <paseo>/node_modules/.bin/tsx test/paseo-compile.mts <compiler-dir> <paseo-plugins-dir> <plugin-dir> <out-dir>
// <compiler-dir> holds compiler.ts (the checkout's, or one extracted from a tag); <paseo-plugins-dir> is the
// checkout's packages/server/src/server/plugins, for the manifest reader and the bundle evaluator.
// Writes result.json into out-dir: { error } or { clientBytes, serverBytes, handlers, hooks, settings }.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [compilerDir, paseoPlugins, pluginDir, outDir] = process.argv.slice(2) as [string, string, string, string];
const finish = (result: object) => writeFileSync(join(outDir, "result.json"), JSON.stringify(result));

const { compilePlugin } = await import(join(compilerDir, "compiler.ts"));
const { readPluginManifest } = await import(join(paseoPlugins, "manifest.ts"));
const { evaluateBundle } = await import(join(paseoPlugins, "bundle-evaluator.ts"));

try {
  await readPluginManifest(pluginDir);
  const { clientBundle, serverBundle } = await compilePlugin({ client: join(pluginDir, "index.client.tsx"), server: join(pluginDir, "index.server.ts") });
  const handlers: string[] = [];
  const hooks: string[] = [];
  const settings: string[] = [];
  const cleanup = evaluateBundle(serverBundle)({
    registerSettings: (definition: { id: string }) => {
      settings.push(definition.id);
      return { read: async () => ({ status: "invalid", revision: "", error: "test" }), subscribe: () => () => {} };
    },
    on: (name: string) => {
      hooks.push(name);
      return () => {};
    },
    handle: (contract: { name: string }) => void handlers.push(contract.name),
  });
  await cleanup?.();
  finish({ clientBytes: clientBundle?.length ?? 0, serverBytes: serverBundle?.length ?? 0, handlers, hooks, settings });
} catch (error) {
  finish({ error: (error as Error).message });
}
