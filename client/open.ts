import { Linking, Platform } from "react-native";

// There is no cross-plugin openScreen: `client.openScreen` only opens this plugin's screens.
// The app's plugin screen route is stable and carries params in the query
// (packages/app/src/plugins/routes.ts, `/h/<server>/plugin/<id>/surface/<screen>?param.<k>=<v>`),
// so this builds that route and hands it to the router.

export function pluginScreenRoute(serverId: string, pluginId: string, screenId: string, params: Record<string, string>): string {
  const path = `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/surface/${encodeURIComponent(screenId)}`;
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(`param.${key}`)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

type WebGlobals = {
  history?: { pushState(state: unknown, title: string, url: string): void };
  dispatchEvent?: (event: unknown) => boolean;
  PopStateEvent?: new (type: string, init?: { state?: unknown }) => unknown;
};

export async function openPluginScreen(serverId: string, pluginId: string, screenId: string, params: Record<string, string>): Promise<"history" | "deep-link"> {
  const route = pluginScreenRoute(serverId, pluginId, screenId, params);
  const web = globalThis as WebGlobals;
  if (Platform.OS === "web" && web.history && web.dispatchEvent && web.PopStateEvent) {
    // Expo Router on web follows browser history: push the route and announce it.
    web.history.pushState(null, "", route);
    web.dispatchEvent(new web.PopStateEvent("popstate", { state: null }));
    return "history";
  }
  // Native: the app's own URL scheme (app.config.js `scheme: "paseo"`), routed by Expo Router.
  await Linking.openURL(`paseo:/${route}`);
  return "deep-link";
}
