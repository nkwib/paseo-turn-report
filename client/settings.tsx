import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Text } from "react-native";
import { settingsDefinition } from "../shared/report";
import { timeoutOptions } from "./format";

const RETRIES = ["0", "1", "2", "3", "5"].map((value) => ({ label: value === "0" ? "Never send" : `${value}`, value }));

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  if (settings.status !== "ready") return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{settings.status === "loading" ? "Loading" : settings.error}</Text>;
  const { values, revision } = settings;
  const save = (patch: Partial<typeof values>) => void settings.save({ ...values, ...patch }, revision);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SettingsSection title="Check">
        <SettingsCard>
          <SettingsSwitch label="Run the project check when a turn ends" value={values.verify} onValueChange={(verify) => save({ verify })} />
          <SettingsInput
            label="Check command"
            hint="Empty: scripts.verify, scripts.check or scripts.test from paseo.json"
            initialValue={values.checkCommand}
            placeholder="npm test"
            onChangeText={(checkCommand) => save({ checkCommand })}
          />
          <SettingsSelect
            label="Stop the check after"
            value={String(values.timeoutSeconds)}
            options={timeoutOptions(values.timeoutSeconds)}
            onValueChange={(v) => save({ timeoutSeconds: Number(v) })}
          />
          <SettingsSelect label="Send failures back to the agent, at most" value={String(values.maxRetries)} options={RETRIES} onValueChange={(v) => save({ maxRetries: Number(v) })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Collisions and documents">
        <SettingsCard>
          <SettingsSwitch label="Check conflicts with other live agents" value={values.collisions} onValueChange={(collisions) => save({ collisions })} />
          <SettingsSwitch label="List documents changed during the turn" value={values.artifacts} onValueChange={(artifacts) => save({ artifacts })} />
          <SettingsInput
            label="Open documents with plugin"
            hint="Plugin id with a 'document' screen. Empty: copy paths only."
            initialValue={values.openWithPluginId}
            onChangeText={(openWithPluginId) => save({ openWithPluginId: openWithPluginId.trim() })}
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
