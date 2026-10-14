import type { RunEvent } from "./types";

/** Page alerts describe newly observed outcomes; replay is retained without notifying. */
export function pageAlertMessages(events: RunEvent[], since: number, observedAt: number): string[] {
  return events.flatMap((event) => {
    if (event.kind === "ready" || event.kind === "unavailable" || event.seq <= since || event.ts < observedAt) return [];
    if (event.kind === "run-end") return [`Review ended: ${event.status}. ${event.stoppedBecause}`];
    return [];
  });
}
