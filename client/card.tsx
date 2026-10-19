import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TurnReport } from "../shared/report";
import { approveCheckRpc, rerunRpc, settingsDefinition } from "../shared/report";
import { docViewerEnabled, showsDocuments, timeAgo, type DocViewerState } from "./format";
import { ReportBody, ReportChips, type ReportActions } from "./report-view";

/** Actions shared by the timeline card and the panel. Built from the closed-over client context. */
export function useReportActions(client: PluginClientContext): ReportActions {
  const toast = useToast();
  return {
    rerun: (report: TurnReport) => {
      client.rpc(rerunRpc, { reportId: report.id }).then(
        (result) => (result.ok ? toast.show("Re-running turn report") : toast.error(result.error ?? "Re-run failed")),
        (error: unknown) => toast.error(String(error)),
      );
    },
    approveCheck: async (report: TurnReport) => {
      if (!report.verify.command) return;
      await client.rpc(approveCheckRpc, { reportId: report.id, command: report.verify.command }).then(
        (result) => (result.ok ? toast.show("Check approved, running it now") : toast.error(result.error ?? "Approval failed")),
        (error: unknown) => toast.error(String(error)),
      );
    },
  };
}

const DOC_VIEWER_TTL_MS = 60_000;

function createDocViewerCheck(client: PluginClientContext) {
  let last: { pluginId: string; at: number; result: Promise<"on" | "off">; value: DocViewerState } | null = null;
  return (pluginId: string) => {
    if (last?.pluginId !== pluginId || Date.now() - last.at > DOC_VIEWER_TTL_MS) {
      const result: Promise<"on" | "off"> = client.paseo.config.get().then(({ config }) => (docViewerEnabled(config, pluginId) ? "on" : "off"), () => "off");
      const next = { pluginId, at: Date.now(), result, value: last?.pluginId === pluginId ? last.value : "unknown" };
      void result.then((value) => (next.value = value));
      last = next;
    }
    return last;
  };
}

const docViewerChecks = new WeakMap<PluginClientContext, ReturnType<typeof createDocViewerCheck>>();

/** Whether the daemon has the doc viewer plugin enabled, cached per client for a minute. */
export function useDocViewer(client: PluginClientContext, pluginId: string | null): DocViewerState {
  let checkDocViewer = docViewerChecks.get(client);
  if (!checkDocViewer) docViewerChecks.set(client, (checkDocViewer = createDocViewerCheck(client)));
  const check = checkDocViewer;
  const [docViewer, setDocViewer] = useState(() => (pluginId === null ? "unknown" : check(pluginId).value));
  useEffect(() => {
    if (pluginId === null) return;
    let live = true;
    void check(pluginId).result.then((value) => live && setDocViewer(value));
    return () => {
      live = false;
    };
  }, [pluginId]);
  return docViewer;
}

export function createTurnReportCard(client: PluginClientContext) {
  return function TurnReportCard({ item, theme, layout }: PluginTimelineItemProps<TurnReport>) {
    const report = item.data;
    const colors = theme.colors;
    // Timeline renderers get the plugin context, so useSettings works here as in screens.
    const settings = useSettings(settingsDefinition);
    const ready = settings.status === "ready" ? settings.values : null;
    const documents = showsDocuments(useDocViewer(client, ready?.openWithPluginId ?? null));
    const actions = useReportActions(client);
    return (
      <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface1 }]} accessibilityLabel="Turn report">
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.foreground }]}>Turn report</Text>
          <Text style={[styles.meta, { color: colors.foregroundMuted }]} numberOfLines={1}>
            {report.branch ? `${report.branch} · ` : ""}
            {timeAgo(report.endedAt)}
          </Text>
        </View>
        <ReportChips report={report} colors={colors} showDocuments={documents} />
        <ReportBody report={report} colors={colors} actions={actions} compact={layout.compact} showDocuments={documents} />
      </View>
    );
  };
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 8, marginVertical: 4 },
  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  title: { fontSize: 13, fontWeight: "600" },
  meta: { fontSize: 12, flexShrink: 1 },
});
