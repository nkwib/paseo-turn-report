import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Platform, StyleSheet, Text, View } from "react-native";
import type { ProofReport, VerifyState } from "../shared/report";
import { checkProvenance, claimLine, claimTone, OUTCOMES, PROOF_ICONS, proofFacts, proofLabel, proofTone, type Tone } from "./format";
import { escapeHidden } from "../shared/report";

type Colors = PluginTheme["colors"];

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function color(colors: Colors, tone: Tone): string {
  if (tone === "success") return colors.statusSuccess;
  if (tone === "danger") return colors.statusDanger;
  if (tone === "warning") return colors.statusWarning;
  return colors.foregroundMuted;
}

const flagged = (tone: Tone) => tone === "danger" || tone === "warning";

/** What the agent claimed next to what the daemon recorded during the turn. */
export function ProofSection({ proof, verifyState, colors, compact }: { proof: ProofReport; verifyState: VerifyState; colors: Colors; compact: boolean }) {
  const tone = proofTone(proof);
  const accent = color(colors, tone);
  const muted = { color: colors.foregroundMuted };
  const fg = { color: colors.foreground };
  const provenance = checkProvenance(proof, verifyState);
  // One shell call can support several kinds of claim. Show its command once.
  const shown = proof.commands.filter((c, i, all) => all.findIndex((other) => other.index === c.index) === i).slice(compact ? -3 : -5);
  return (
    <View style={[styles.section, { borderColor: tone === "muted" ? colors.border : accent }]} accessibilityLabel="Proof">
      <View style={styles.row}>
        <Icon name={PROOF_ICONS[tone]} size={14} color={accent} />
        <Text style={[styles.label, fg]}>Proof</Text>
        <Text style={[styles.meta, { color: accent }]}>{proofLabel(proof)}</Text>
      </View>
      {proof.claims.map((claim) => (
        <View key={claim.kind} style={styles.claim}>
          <Text style={[styles.meta, { color: flagged(claimTone(claim)) ? color(colors, claimTone(claim)) : colors.foreground }]}>{claimLine(claim)}</Text>
          <Text style={[styles.quote, muted]} numberOfLines={2}>
            “{claim.text}”
          </Text>
        </View>
      ))}
      <Text style={[styles.meta, muted]}>{proofFacts(proof)}</Text>
      {provenance ? <Text style={[styles.meta, muted]}>Check {provenance}</Text> : null}
      {shown.map((c) => (
        <View key={c.index} style={styles.row}>
          <Icon name={OUTCOMES[c.outcome].icon} size={13} color={color(colors, OUTCOMES[c.outcome].tone)} />
          <Text style={[styles.mono, styles.flex, fg]} numberOfLines={1} ellipsizeMode="middle">
            {escapeHidden(c.command)}
          </Text>
          <Text style={[styles.meta, muted]}>{c.exitCode !== null ? `exit ${c.exitCode}` : OUTCOMES[c.outcome].label}</Text>
        </View>
      ))}
      {proof.testFiles.map((path) => (
        <View key={path} style={styles.row}>
          <Icon name="FlaskConical" size={13} color={colors.statusWarning} />
          <Text style={[styles.mono, styles.flex, fg]} numberOfLines={1} ellipsizeMode="middle">
            {path}
          </Text>
          <Text style={[styles.meta, muted]}>test file edited</Text>
        </View>
      ))}
      {proof.deniedTools.slice(0, 3).map((tool, i) => (
        <View key={`denied-${tool.name}-${i}`} style={styles.row}>
          <Icon name={OUTCOMES.denied.icon} size={13} color={colors.foregroundMuted} />
          <Text style={[styles.meta, styles.flex, muted]} numberOfLines={1} ellipsizeMode="middle">
            {tool.name} denied{tool.summary ? `: ${tool.summary}` : ""}
          </Text>
        </View>
      ))}
      {proof.failedTools.slice(0, 3).map((tool, i) => (
        <Text key={`${tool.name}-${i}`} style={[styles.meta, { color: colors.statusDanger }]} numberOfLines={1}>
          {tool.name} failed{tool.summary ? `: ${tool.summary}` : ""}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 4, borderLeftWidth: 2, paddingLeft: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 },
  claim: { gap: 1 },
  flex: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: "600" },
  meta: { fontSize: 12 },
  quote: { fontSize: 12, fontStyle: "italic" },
  mono: { fontFamily: MONO, fontSize: 12, flexShrink: 1 },
});
