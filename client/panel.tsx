import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TurnReport } from "../shared/report";
import { BOARD_LIMIT, recentReportsRpc, settingsDefinition } from "../shared/report";
import { useDocViewer, useReportActions } from "./card";
import { boardSummary, footerSummary, latestPerAgent, overallTone, showsDocuments, timeAgo } from "./format";
import { ReportBody, ReportChips, toneColor } from "./report-view";

const POLL_MS = 4_000;
export const BOARD_SCREEN_ID = "board";

function useReports(client: PluginClientContext, workspaceId: string | null) {
  const [reports, setReports] = useState<TurnReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client.rpc(recentReportsRpc, { workspaceId, limit: BOARD_LIMIT }).then(
      (result) => {
        setReports(result.reports);
        setError(null);
      },
      (e: unknown) => setError(String(e)),
    );
  }, [workspaceId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { reports, error };
}

type Navigation = PluginWorkspacePanelProps["navigation"];

function Board({ client, scope, theme, host, compact, navigation, onScopeChange }: {
  client: PluginClientContext;
  scope: { workspaceId: string | null };
  theme: PluginTheme;
  host: { id: string };
  compact: boolean;
  navigation: Navigation;
  onScopeChange?: (all: boolean) => void;
}) {
  const colors = theme.colors;
  const settings = useSettings(settingsDefinition);
  const { reports, error } = useReports(client, scope.workspaceId);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const ready = settings.status === "ready" ? settings.values : null;
  const documents = showsDocuments(useDocViewer(client, ready?.openWithPluginId ?? null));
  const base = useReportActions(client);
  const actions = { ...base, openAgent: navigation ? (agentId: string) => navigation.openAgent({ agentId, serverId: host.id }) : undefined };
  const list = history ? (reports ?? []) : latestPerAgent(reports ?? []);
  const summary = boardSummary(reports ?? []);
  const muted = { color: colors.foregroundMuted };

  const tile = (label: string, value: number, color: string) => (
    <View key={label} style={[styles.tile, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
      <Text style={[styles.tileValue, { color: value > 0 ? color : colors.foregroundMuted }]}>{value}</Text>
      <Text style={[styles.meta, muted]}>{label}</Text>
    </View>
  );
  const pill = (label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.toggle, { borderColor: colors.border, backgroundColor: active ? colors.accent : colors.surface1 }]}
    >
      <Text style={[styles.toggleText, { color: active ? colors.accentForeground : colors.foreground }]}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={[styles.content, compact && styles.contentCompact]}>
      <View style={styles.tiles}>
        {tile("green", summary.green, colors.statusSuccess)}
        {tile("amber", summary.amber, colors.statusWarning)}
        {tile("red", summary.red, colors.statusDanger)}
      </View>
      <View style={styles.toolbar}>
        <Text style={[styles.heading, { color: colors.foreground }]}>{history ? "All turns" : "Latest turn per agent"}</Text>
        <View style={styles.pills}>
          {onScopeChange ? pill("All workspaces", scope.workspaceId === null, () => onScopeChange(scope.workspaceId !== null)) : null}
          {pill("History", history, () => setHistory(!history))}
        </View>
      </View>
      {error ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{error}</Text> : null}
      {reports && reports.length === 0 ? <Text style={[styles.meta, muted]}>No turn reports yet. One appears here and in the agent's chat when a turn ends.</Text> : null}
      {list.map((report) => {
        const expanded = open === report.id;
        return (
          <View key={report.id} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`Turn report for ${report.agentTitle}`}
              onPress={() => setOpen(expanded ? null : report.id)}
              style={styles.rowHeader}
            >
              <View style={[styles.dot, { backgroundColor: toneColor(colors, overallTone(report)) }]} />
              <Text style={[styles.agent, { color: colors.foreground }]} numberOfLines={1}>
                {report.agentTitle}
              </Text>
              <Text style={[styles.meta, muted]} numberOfLines={1}>
                {report.branch ? `${report.branch} · ` : ""}
                {timeAgo(report.endedAt)}
              </Text>
              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
            </Pressable>
            <ReportChips report={report} colors={colors} showDocuments={documents} />
            {expanded ? <ReportBody report={report} colors={colors} actions={actions} compact={compact} showDocuments={documents} /> : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

export function createReportsPanel(client: PluginClientContext) {
  return function ReportsPanel({ workspaceId, theme, host, layout, navigation }: PluginWorkspacePanelProps) {
    const [all, setAll] = useState(false);
    return <Board client={client} scope={{ workspaceId: all ? null : workspaceId }} theme={theme} host={host} compact={layout.compact} navigation={navigation} onScopeChange={setAll} />;
  };
}

export function createBoardScreen(client: PluginClientContext) {
  return function BoardScreen({ theme, host, layout, navigation }: PluginScreenProps) {
    return <Board client={client} scope={{ workspaceId: null }} theme={theme} host={host} compact={layout.compact} navigation={navigation} />;
  };
}

/** Sidebar footer: the most urgent count across every agent on this host ("1 red", "2 unchecked"); opens the board. */
export function createSidebarSummary(client: PluginClientContext) {
  return function SidebarSummary({ openScreen, currentScreen, theme }: PluginSidebarItemProps) {
    const { reports } = useReports(client, null);
    const footer = footerSummary(reports ?? []);
    return (
      <SidebarRow
        icon="ListChecks"
        label="Turn reports"
        active={currentScreen?.screenId === BOARD_SCREEN_ID}
        onPress={() => openScreen({ screenId: BOARD_SCREEN_ID })}
        trailing={
          footer ? (
            <Text style={{ fontSize: 11, color: toneColor(theme.colors, footer.tone) }} numberOfLines={1}>
              {footer.text}
            </Text>
          ) : null
        }
      />
    );
  };
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 10 },
  contentCompact: { padding: 12 },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, minWidth: 0 },
  tileValue: { fontSize: 22, fontWeight: "700" },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  pills: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  heading: { fontSize: 14, fontWeight: "600" },
  toggle: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, minHeight: 30, justifyContent: "center" },
  toggleText: { fontSize: 12 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  agent: { fontSize: 13, fontWeight: "600", flex: 1, minWidth: 0 },
  meta: { fontSize: 12 },
});
