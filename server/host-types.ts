import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Host types come from the SDK specifiers only. A Git install has no node_modules, and Paseo's compiler fails on a
// type-only import it cannot resolve unless it is an SDK specifier, zod or react.
export type PaseoApi = PluginHandlerContext["paseo"];
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
