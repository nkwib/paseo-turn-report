import { describe, expect, it } from "vitest";
import { IDLE, stepRetry, type RetryEvent, type RetryState } from "../server/retry";

function run(events: RetryEvent[], max = 2, from: RetryState = IDLE) {
  let state = from;
  const log: string[] = [];
  for (const event of events) {
    const step = stepRetry(state, event, max);
    state = step.next;
    if (event.type.startsWith("check")) log.push(`${step.action}@${step.attempt}`);
  }
  return { state, log };
}

describe("stepRetry", () => {
  it("passes on the first check", () => {
    expect(run([{ type: "turn_started" }, { type: "check_passed" }])).toEqual({ state: IDLE, log: ["none@1"] });
  });

  it("sends follow-ups up to maxRetries, then gives up", () => {
    const { state, log } = run([
      { type: "turn_started" }, { type: "check_failed" },
      { type: "turn_started" }, { type: "check_failed" },
      { type: "turn_started" }, { type: "check_failed" },
    ]);
    expect(log).toEqual(["send_followup@1", "send_followup@2", "give_up@3"]);
    expect(state).toEqual(IDLE);
  });

  it("regression: the streak resets after giving up, so the user's next turn is attempt 1", () => {
    const { log } = run([
      { type: "turn_started" }, { type: "check_failed" },
      { type: "turn_started" }, { type: "check_failed" }, // max 1 -> gave up at 2
      { type: "turn_started" }, { type: "check_failed" },
    ], 1);
    expect(log).toEqual(["send_followup@1", "give_up@2", "send_followup@1"]);
  });

  it("passing on a follow-up reports the attempt number and resets", () => {
    const { state, log } = run([{ type: "turn_started" }, { type: "check_failed" }, { type: "turn_started" }, { type: "check_passed" }]);
    expect(log).toEqual(["send_followup@1", "none@2"]);
    expect(state).toEqual(IDLE);
  });

  it("a user turn in the middle of a chain resets it", () => {
    // follow-up turn runs, ends without a check (e.g. failed turn), then the user starts a turn
    const { log } = run([{ type: "turn_started" }, { type: "check_failed" }, { type: "turn_started" }, { type: "turn_started" }, { type: "check_failed" }]);
    expect(log).toEqual(["send_followup@1", "send_followup@1"]);
  });

  it("cancel and send failure end the chain", () => {
    expect(run([{ type: "check_failed" }, { type: "turn_canceled" }]).state).toEqual(IDLE);
    expect(run([{ type: "check_failed" }, { type: "send_failed" }]).state).toEqual(IDLE);
  });

  it("maxRetries 0 gives up on the first failure", () => {
    expect(run([{ type: "turn_started" }, { type: "check_failed" }], 0).log).toEqual(["give_up@1"]);
  });
});
