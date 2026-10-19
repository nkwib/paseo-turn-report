import { describe, expect, it } from "vitest";
import { REPORT_KIND } from "../shared/report";

// Mirrors CONTRIBUTION_ID in packages/app/src/plugins/evaluate.ts:40. A violation throws inside
// addTimelineRenderer, the client bundle fails to evaluate, and every surface of the plugin disappears.
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

describe("host contract", () => {
  it("timeline renderer kind is a valid contribution id", () => {
    expect(REPORT_KIND).toMatch(CONTRIBUTION_ID);
  });
});
