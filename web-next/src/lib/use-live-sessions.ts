import { useEffect, useRef, useState } from "react";
import { createLiveFold, type DerivedSession } from "./live-fold";
import type { RunEvent } from "./types";

/**
 * Incremental fold of the merged SSE buffer into per-session views. The fold
 * keeps a sequence cursor, so each render only appends events it has not seen;
 * merged cumulative deltas still land on the existing streaming tail.
 */
export function useLiveSessions(events: RunEvent[] | null, key: string): DerivedSession[] {
  const [sessions, setSessions] = useState<DerivedSession[]>([]);
  const stateRef = useRef<{ key: string; cursor: number; fold: ReturnType<typeof createLiveFold> }>({
    key,
    cursor: 0,
    fold: createLiveFold(),
  });

  useEffect(() => {
    if (stateRef.current.key === key) return;
    stateRef.current = { key, cursor: 0, fold: createLiveFold() };
    setSessions([]);
  }, [key]);

  useEffect(() => {
    if (events === null) {
      setSessions([]);
      return;
    }
    const state = stateRef.current;
    const batch: RunEvent[] = [];
    let cursor = state.cursor;
    for (const event of events) {
      if (event.kind === "ready" || event.kind === "unavailable") continue;
      if (event.seq <= cursor) continue;
      cursor = event.seq;
      batch.push(event);
    }
    if (batch.length === 0) return;
    state.cursor = cursor;
    setSessions(state.fold.append(batch));
  }, [events]);

  return sessions;
}
