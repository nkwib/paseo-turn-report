import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Artifact, TurnReport } from "../shared/report";
import { escapeHidden } from "../shared/report";
import { ProofSection } from "./proof-view";
import {
  approvalPrompt,
  ARTIFACT_ICONS,
  PROOF_ICONS,
  proofLabel,
  proofTone,
  artifactLabel,
  canOpenInDocViewer,
  checkRan,
  collisionLabel,
  formatDuration,
  formatSize,
  verifyLabel,
  verifyTone,
  type Tone,
} from "./format";

type Colors = PluginTheme["colors"];

export interface ReportActions {
  rerun?: (report: TurnReport) => void;
  /** Settles when the approval request does; the button stays disabled until then. */
  approveCheck?: (report: TurnReport) => Promise<void>;
  openArtifact?: (report: TurnReport, artifact: Artifact) => void;
  openAgent?: (agentId: string) => void;
}

// "monospace" is the one family name react-native-web maps to a real stack; a CSS font list is dropped on web.
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

export function toneColor(colors: Colors, tone: Tone): string {
  if (tone === "success") return colors.statusSuccess;
  if (tone === "danger") return colors.statusDanger;
  if (tone === "warning") return colors.statusWarning;
  return colors.foregroundMuted;
}

function verifyIcon(report: TurnReport): string {
  const tone = verifyTone(report.verify.state);
  if (report.verify.state === "running") return "LoaderCircle";
  if (report.verify.state === "needs_approval") return "Lock";
  if (tone === "success") return "CircleCheck";
  if (tone === "danger") return "CircleX";
  if (tone === "warning") return "CircleAlert";
  return "CircleMinus";
}

function Chip({ colors, icon, label, tone }: { colors: Colors; icon: string; label: string; tone: Tone }) {
  const color = toneColor(colors, tone);
  return (
    <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.surface2 }]}>
      <Icon name={icon} size={13} color={color} />
      <Text style={[styles.chipText, { color: tone === "muted" ? colors.foregroundMuted : colors.foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function SmallButton({ colors, icon, label, onPress, disabled = false }: { colors: Colors; icon: string; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.button, { borderColor: colors.border, backgroundColor: pressed ? colors.surface2 : colors.surface1 }, disabled && styles.disabled]}
    >
      <Icon name={icon} size={13} color={colors.foreground} />
      <Text style={[styles.buttonText, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** One-line glance: check, collisions, documents. */
export function ReportChips({ report, colors }: { report: TurnReport; colors: Colors }) {
  const collisionTone: Tone = report.collisions.items.length > 0 ? "danger" : report.collisions.state === "done" ? "success" : "muted";
  const proofChip = report.proof ? proofTone(report.proof) : "muted";
  return (
    <View style={styles.chips}>
      {report.proof && (proofChip === "danger" || proofChip === "warning") ? <Chip colors={colors} icon={PROOF_ICONS[proofChip]} label={proofLabel(report.proof)} tone={proofChip} /> : null}
      <Chip colors={colors} icon={verifyIcon(report)} label={verifyLabel(report)} tone={verifyTone(report.verify.state)} />
      <Chip colors={colors} icon="GitMerge" label={collisionLabel(report)} tone={collisionTone} />
      <Chip colors={colors} icon="Files" label={artifactLabel(report)} tone="muted" />
    </View>
  );
}

export function ReportBody({ report, colors, actions, compact, showDocuments }: { report: TurnReport; colors: Colors; actions: ReportActions; compact: boolean; showDocuments: boolean }) {
  const toast = useToast();
  const v = report.verify;
  const failed = v.state === "failed" || v.state === "gave_up" || v.state === "retrying" || v.state === "busy";
  const [showTail, setShowTail] = useState(failed);
  const [approving, setApproving] = useState(false);
  const approve = () => {
    if (approving || !actions.approveCheck) return;
    setApproving(true);
    void actions.approveCheck(report).finally(() => setApproving(false));
  };
  const copy = (text: string, what: string) => {
    copyText(text).then(
      () => toast.show(`Copied ${what}`, { variant: "success" }),
      () => toast.error("Copy is not available here"),
    );
  };
  const muted = { color: colors.foregroundMuted };
  const fg = { color: colors.foreground };
  const approval = v.state === "needs_approval" && v.command ? approvalPrompt(v) : null;

  return (
    <View style={styles.body}>
      {report.proof ? <ProofSection proof={report.proof} verifyState={v.state} colors={colors} compact={compact} /> : null}
      {/* Check */}
      {approval ? (
        <View style={[styles.section, styles.approval, { borderColor: colors.border, backgroundColor: colors.surface2 }]} accessibilityLabel="Check needs approval">
          <Text style={[styles.meta, fg]}>{v.note ?? "paseo.json"} asks to run this command after each turn. It runs only once you approve this exact command for this workspace.</Text>
          <Text style={[styles.mono, fg]} selectable>
            {approval.command}
          </Text>
          {approval.warning ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{approval.warning}</Text> : null}
          {actions.approveCheck && approval.approvable ? (
            <View style={styles.rowWrap}>
              <SmallButton colors={colors} icon="Play" label={approving ? "Approving..." : "Run this check after each turn"} onPress={approve} disabled={approving} />
            </View>
          ) : null}
        </View>
      ) : v.command ? (
        <View style={styles.section}>
          <View style={styles.rowWrap}>
            <Text style={[styles.mono, fg]} numberOfLines={1}>
              {escapeHidden(v.command)}
            </Text>
            {v.exitCode !== null ? <Text style={[styles.meta, muted]}>exit {v.exitCode} · {formatDuration(v.durationMs)}</Text> : null}
          </View>
          {v.note ? <Text style={[styles.meta, muted]}>{v.note}</Text> : null}
          {v.tail || (actions.rerun && checkRan(v.state)) ? (
            <View style={styles.rowWrap}>
              {v.tail ? (
                <SmallButton colors={colors} icon={showTail ? "ChevronDown" : "ChevronRight"} label={showTail ? "Hide output" : "Show output"} onPress={() => setShowTail(!showTail)} />
              ) : null}
              {actions.rerun && checkRan(v.state) ? <SmallButton colors={colors} icon="RotateCw" label="Re-run" onPress={() => actions.rerun?.(report)} /> : null}
              {v.tail ? <SmallButton colors={colors} icon="Copy" label="Copy output" onPress={() => copy(v.tail, "output")} /> : null}
            </View>
          ) : null}
          {showTail && v.tail ? (
            <View style={[styles.tail, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
              <Text style={[styles.tailText, fg]} selectable numberOfLines={compact ? 14 : 24}>
                {v.tail.split("\n").slice(compact ? -14 : -24).join("\n")}
              </Text>
            </View>
          ) : null}
        </View>
      ) : v.note ? (
        <Text style={[styles.meta, muted]}>{v.note}</Text>
      ) : null}

      {/* Collisions */}
      {report.collisions.items.map((peer) => (
        <View key={peer.agentId} style={[styles.section, styles.peer, { borderColor: colors.statusDanger }]}>
          <View style={styles.rowWrap}>
            <Icon name="GitMerge" size={13} color={colors.statusDanger} />
            <Text style={[styles.label, fg]} numberOfLines={1}>
              {peer.agentTitle}
            </Text>
            <Text style={[styles.meta, muted]} numberOfLines={1}>
              {peer.branch}
            </Text>
            {actions.openAgent ? <SmallButton colors={colors} icon="ExternalLink" label="Open agent" onPress={() => actions.openAgent?.(peer.agentId)} /> : null}
          </View>
          {peer.files.map((file) => (
            <View key={file.path} style={styles.fileRow}>
              <Text style={[styles.mono, styles.flex, fg]} numberOfLines={1} ellipsizeMode="middle">
                {file.path}
              </Text>
              <Text style={[styles.meta, muted]}>{file.kind}</Text>
            </View>
          ))}
          {peer.moreFiles > 0 ? <Text style={[styles.meta, muted]}>+{peer.moreFiles} more</Text> : null}
        </View>
      ))}
      {report.collisions.note && report.collisions.state === "error" ? <Text style={[styles.meta, { color: colors.statusDanger }]}>{report.collisions.note}</Text> : null}

      {(showDocuments ? report.artifacts.items : []).map((artifact) => (
        <View key={artifact.path} style={styles.fileRow}>
          <Icon name={ARTIFACT_ICONS[artifact.kind] ?? "File"} size={14} color={colors.foregroundMuted} />
          <View style={styles.flex}>
            <Text style={[styles.mono, fg]} numberOfLines={1} ellipsizeMode="middle">
              {artifact.path}
            </Text>
            <Text style={[styles.meta, muted]}>
              {artifact.status} · {formatSize(artifact.size)}
            </Text>
          </View>
          {actions.openArtifact && canOpenInDocViewer(artifact.path) ? (
            <SmallButton colors={colors} icon="ExternalLink" label="Open" onPress={() => actions.openArtifact?.(report, artifact)} />
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`Copy path ${artifact.path}`} hitSlop={8} onPress={() => copy(joinPath(report.cwd, artifact.path), "path")} style={styles.iconButton}>
            <Icon name="Copy" size={14} color={colors.foregroundMuted} />
          </Pressable>
        </View>
      ))}
      {showDocuments && report.artifacts.more > 0 ? <Text style={[styles.meta, muted]}>+{report.artifacts.more} more documents</Text> : null}
    </View>
  );
}

function joinPath(root: string, rel: string): string {
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

const styles = StyleSheet.create({
  body: { gap: 8 },
  section: { gap: 4 },
  peer: { borderLeftWidth: 2, paddingLeft: 8 },
  approval: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, maxWidth: "100%" },
  chipText: { fontSize: 12, flexShrink: 1 },
  rowWrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  flex: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: 12, flexShrink: 1 },
  label: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  meta: { fontSize: 12 },
  button: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, minHeight: 28 },
  buttonText: { fontSize: 12 },
  disabled: { opacity: 0.5 },
  iconButton: { padding: 6, minWidth: 28, minHeight: 28, alignItems: "center", justifyContent: "center" },
  tail: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 8 },
  tailText: { fontFamily: MONO, fontSize: 11, lineHeight: 15 },
});
