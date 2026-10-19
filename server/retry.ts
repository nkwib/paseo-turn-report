// Per-agent retry state for the verify gate. Pure: the caller owns the Map and the side effects.
//
// A "failure streak" counts consecutive failed checks within one chain of plugin follow-ups.
// The chain ends, and the streak resets, when the check passes, when the gate gives up,
// when a send fails, when the user cancels, or when a turn starts that the plugin did not request.

export type RetryState =
  | { kind: "idle" }
  | { kind: "awaiting_followup"; failures: number }
  | { kind: "in_followup"; failures: number };

export type RetryEvent =
  | { type: "turn_started" }
  | { type: "turn_canceled" }
  | { type: "check_passed" }
  | { type: "check_failed" }
  | { type: "send_failed" };

export type RetryAction = "none" | "send_followup" | "give_up";

export interface RetryStep {
  next: RetryState;
  action: RetryAction;
  /** 1-based index of the check that produced this step (0 for non-check events). */
  attempt: number;
}

export const IDLE: RetryState = { kind: "idle" };

export function stepRetry(state: RetryState, event: RetryEvent, maxRetries: number): RetryStep {
  switch (event.type) {
    case "turn_started":
      // Only the turn the plugin asked for continues the streak; any other turn is the user's.
      if (state.kind === "awaiting_followup") return { next: { kind: "in_followup", failures: state.failures }, action: "none", attempt: 0 };
      return { next: IDLE, action: "none", attempt: 0 };
    case "turn_canceled":
    case "send_failed":
      return { next: IDLE, action: "none", attempt: 0 };
    case "check_passed":
      return { next: IDLE, action: "none", attempt: priorFailures(state) + 1 };
    case "check_failed": {
      const failures = priorFailures(state) + 1;
      if (failures <= maxRetries) return { next: { kind: "awaiting_followup", failures }, action: "send_followup", attempt: failures };
      // Giving up ends the chain: the next user turn starts again at attempt 1.
      return { next: IDLE, action: "give_up", attempt: failures };
    }
  }
}

function priorFailures(state: RetryState): number {
  return state.kind === "in_followup" ? state.failures : 0;
}
