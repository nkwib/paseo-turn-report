import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { StyleSheet, Text, View } from "react-native";
import type { TurnReport } from "../shared/report";
import { approveCheckRpc, rerunRpc } from "../shared/report";
import { timeAgo } from "./format";
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

export function createTurnReportCard(client: PluginClientContext) {
  return function TurnReportCard({ item, theme, layout }: PluginTimelineItemProps<TurnReport>) {
    const report = item.data;
    const colors = theme.colors;
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
        <ReportChips report={report} colors={colors} />
        <ReportBody report={report} colors={colors} actions={actions} compact={layout.compact} />
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
