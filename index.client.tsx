import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createTurnReportCard } from "./client/card";
import { BOARD_SCREEN_ID, createBoardScreen, createReportsPanel, createSidebarSummary } from "./client/panel";
import { SettingsScreen } from "./client/settings";
import { REPORT_KIND, REPORT_SCHEMAS } from "./shared/report";

const PANEL_ID = "turn-reports";

export default function contribute(client: PluginClientContext) {
  const Card = createTurnReportCard(client);
  const cleanups = [
    ...Array.from(REPORT_SCHEMAS, ([version, schema]) => client.addTimelineRenderer({ kind: REPORT_KIND, version, schema, Component: Card })),
    client.addScreen({ id: BOARD_SCREEN_ID, title: "Turn reports", Component: createBoardScreen(client) }),
    client.addSidebarFooterItem({ id: "turn-reports", title: "Turn reports", Component: createSidebarSummary(client) }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Turn reports", icon: "ListChecks", context: "workspace", Component: createReportsPanel(client) }),
    client.addCommandCenterItem({
      id: "open-turn-reports",
      title: "Open turn reports",
      icon: "ListChecks",
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(PANEL_ID),
    }),
    client.addCommandCenterItem({ id: "open-turn-board", title: "Open turn report board", icon: "ListChecks", context: "global", onSelect: ({ openScreen }) => openScreen({ screenId: BOARD_SCREEN_ID }) }),
    client.addSettingsScreen({ id: "turn-report", title: "Turn report", icon: "ListChecks", Component: SettingsScreen }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
