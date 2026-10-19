import type { PluginServerContext } from "@getpaseo/plugin/server";
import { approveCheckRpc, DEFAULT_SETTINGS, recentReportsRpc, rerunRpc, settingsDefinition } from "./shared/report";
import { createCheckApprovals } from "./server/approvals";
import { createReportService, type ReportService } from "./server/service";
import { createSaver, dataDirectory, ensurePrivateDirectory, loadReports } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(settingsDefinition);
  const readSettings = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_SETTINGS;
  };
  const dir = dataDirectory();
  const saver = createSaver(dir);
  // contribute() is synchronous; hooks and RPCs wait for the stored reports to load.
  const ready: Promise<ReportService> = ensurePrivateDirectory(dir).then(
    async () => {
      const approvals = createCheckApprovals(dir);
      const initial = await loadReports(dir).catch((error: unknown) => {
        console.error(`[turn-report] reports stay in memory, ${dir}/reports.json is left as it is: ${String(error)}`);
        return null;
      });
      if (!initial) return createReportService(readSettings, { initial: [], save: () => {} }, approvals);
      console.log(`[turn-report] store ${dir} (${initial.length} reports)`);
      return createReportService(readSettings, { initial, save: saver.save }, approvals);
    },
    (error: unknown) => {
      // Approvals read from a folder someone else controls could pre-approve any command, so nothing is read or saved.
      console.error(`[turn-report] not using ${dir}, reports and check approvals stay in memory: ${String(error)}`);
      return createReportService(readSettings, { initial: [], save: () => {} }, createCheckApprovals(null));
    },
  );

  server.on("agent.turn_started", async ({ agent, turnId }) => (await ready).turnStarted(agent, turnId));
  // Returns at once: hooks have a 30 s budget, and the check can take minutes.
  server.on("agent.turn_ended", async ({ agent, turnId, outcome, timeline }, { paseo }) => (await ready).turnEnded({ agent, turnId, outcome, timeline }, paseo));
  server.handle(recentReportsRpc, async ({ workspaceId, limit }) => ({ reports: (await ready).recent(workspaceId, limit) }));
  server.handle(rerunRpc, async ({ reportId }, { paseo }) => (await ready).rerun(reportId, paseo));
  server.handle(approveCheckRpc, async ({ reportId, command }, { paseo }) => (await ready).approveCheck(reportId, command, paseo));

  return async () => {
    await (await ready).dispose();
    await saver.close();
  };
}
