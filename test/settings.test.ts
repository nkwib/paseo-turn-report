import { describe, expect, it } from "vitest";
import { timeoutOptions } from "../client/format";
import { DEFAULT_SETTINGS, settingsDefinition } from "../shared/report";

describe("settings screen", () => {
  it("offers check timeouts the setting accepts, with the default and the current value", () => {
    const field = settingsDefinition.schema.shape.timeoutSeconds;
    const options = timeoutOptions(DEFAULT_SETTINGS.timeoutSeconds);
    expect(options.map((o) => o.label)).toEqual(["1 min", "2 min", "5 min", "10 min", "20 min", "30 min", "60 min"]);
    for (const option of options) expect(field.safeParse(Number(option.value)).success).toBe(true);
    expect(options.some((o) => Number(o.value) === DEFAULT_SETTINGS.timeoutSeconds)).toBe(true);
    // A value set elsewhere stays selectable instead of showing blank.
    expect(timeoutOptions(90).map((o) => o.label)).toEqual(["1 min", "90 s", "2 min", "5 min", "10 min", "20 min", "30 min", "60 min"]);
  });
});
