import type { RunEvent, SessionUsage } from "./types";

// ---------------------------------------------------------------------------
// Live derivation: fold the event stream of each session into render items.
// Deltas stream into a buffer; the authoritative session-block supersedes it.
//
// Pure logic (no React) so the flush/fold contract is testable from the root
// node test suite.
// ---------------------------------------------------------------------------

export type LiveItem =
  | { type: "thinking"; text: string; streaming: boolean }
  | { type: "text"; text: string; streaming: boolean }
  | { type: "tool"; name: string; args: unknown; callId: string; result?: { text: string; isError: boolean; truncated: boolean }; running: boolean };

export interface DerivedSession {
  sessionId: string;
  kind: "reviewer" | "verifier";
  role: string;
  model: string | null;
  round?: number;
  unitId?: string;
  attempt?: number;
  displayId?: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  error?: string;
  usage?: SessionUsage;
  items: LiveItem[];
}

/**
 * Merge a batch of buffered live events into the list in one pass. The SSE
 * replay can hand over tens of thousands of events at once; folding them one
 * by one (copying the array per event) is quadratic, this is O(list + batch).
 * Consecutive same-session/same-type deltas collapse into one element with
 * cumulative text and the newest seq — including into the previous flush's
 * last element, which is what keeps the array bounded during streaming.
 */
export function mergeEvents(previous: RunEvent[], pending: RunEvent[]): RunEvent[] {
  const merged = previous.slice();
  for (const event of pending) {
    const last = merged[merged.length - 1];
    if (
      event.kind === "session-delta" &&
      last?.kind === "session-delta" &&
      last.sessionId === event.sessionId &&
      last.deltaType === event.deltaType
    ) {
      // A replayed delta can itself carry cumulative text from the streak's
      // start — the server coalesces buffered streaks past its event cap
      // (F-74). Such text already contains what we hold, so replace instead
      // of re-appending; genuinely incremental chunks never start with the
      // whole held text and keep appending. Same bet the fold's buffer
      // makes below.
      const text = event.text.startsWith(last.text) ? event.text : last.text + event.text;
      merged[merged.length - 1] = { ...last, text, seq: event.seq, ts: event.ts };
    } else {
      merged.push(event);
    }
  }
  return merged;
}

/**
 * Incremental fold over the live event stream. The whole run's history can
 * reach tens of thousands of events; re-folding it on every 80ms flush was the
 * old cost, and it reallocated every session (defeating React.memo). Here the
 * fold keeps per-session state and only sessions touched by new events get a
 * fresh view object — untouched ones keep their identity and skip re-render.
 */
export interface LiveFold {
  /** Fold events past the seq cursor; returns the current session views. */
  append(events: RunEvent[]): DerivedSession[];
}

interface FoldSession {
  meta: Omit<DerivedSession, "items">;
  items: LiveItem[];
  /** callId → index into items, for pairing tool results with their calls. */
  openTools: Map<string, number>;
  /** Cached view; null whenever this session received new events. */
  view: DerivedSession | null;
}

export function createLiveFold(): LiveFold {
  const sessions = new Map<string, FoldSession>();
  const buffers = new Map<string, { kind: "thinking" | "text"; text: string }>();
  let cursor = 0;

  const flushBuffer = (sessionId: string): void => {
    const fold = sessions.get(sessionId);
    const buffer = buffers.get(sessionId);
    if (!fold || !buffer) return;
    buffers.delete(sessionId);
    fold.items.push({ type: buffer.kind, text: buffer.text, streaming: false });
    fold.view = null;
  };

  const append = (events: RunEvent[]): DerivedSession[] => {
    for (const event of events) {
      // Control frames (ready/unavailable) carry no seq and are not foldable.
      if (event.kind === "ready" || event.kind === "unavailable") continue;
      if (event.seq <= cursor) continue;
      cursor = event.seq;

      if (event.kind === "session-start") {
        sessions.set(event.sessionId, {
          meta: {
            sessionId: event.sessionId,
            kind: event.sessionKind,
            role: event.role,
            model: event.model,
            ...(event.round !== undefined ? { round: event.round } : {}),
            ...(event.unitId !== undefined ? { unitId: event.unitId } : {}),
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
            ...(event.displayId !== undefined ? { displayId: event.displayId } : {}),
            prompt: event.prompt,
            startedAt: event.ts,
            endedAt: null,
          },
          items: [],
          openTools: new Map(),
          view: null,
        });
      } else if (event.kind === "session-delta") {
        const fold = sessions.get(event.sessionId);
        if (!fold) continue;
        const buffer = buffers.get(event.sessionId);
        if (buffer && buffer.kind === event.deltaType) {
          // mergeEvents folds each 80ms batch into the last array element, so
          // a delta re-observed past the seq cursor carries cumulative text
          // from the run's start. Text that already contains what we hold
          // means replace, not re-append — appending here re-added the whole
          // tail on every flush (dogfood F-35). The startsWith fallback keeps
          // genuinely new (unmerged) deltas appending.
          buffer.text = event.text.startsWith(buffer.text) ? event.text : buffer.text + event.text;
        } else {
          flushBuffer(event.sessionId);
          buffers.set(event.sessionId, { kind: event.deltaType, text: event.text });
        }
        fold.view = null; // the streaming tail item grows
      } else if (event.kind === "session-block") {
        const fold = sessions.get(event.sessionId);
        if (!fold) continue;
        const block = event.block;
        if (block.type === "toolCall") {
          flushBuffer(event.sessionId);
          fold.openTools.set(block.id, fold.items.length);
          fold.items.push({ type: "tool", name: block.name, args: block.arguments, callId: block.id, running: true });
        } else {
          const buffer = buffers.get(event.sessionId);
          const kind = block.type === "thinking" ? "thinking" : "text";
          if (!buffer || buffer.kind !== kind) flushBuffer(event.sessionId);
          else buffers.delete(event.sessionId); // streamed content settles into the block
          fold.items.push({ type: kind, text: block.text, streaming: false });
        }
        fold.view = null;
      } else if (event.kind === "session-tool-result") {
        const fold = sessions.get(event.sessionId);
        if (!fold) continue;
        const result = { text: event.result, isError: event.isError, truncated: event.truncated };
        const index = fold.openTools.get(event.toolCallId);
        if (index !== undefined && fold.items[index]?.type === "tool") {
          const open = fold.items[index] as Extract<LiveItem, { type: "tool" }>;
          fold.items[index] = { ...open, result, running: false };
          fold.openTools.delete(event.toolCallId);
        } else {
          fold.items.push({ type: "tool", name: event.name, args: {}, callId: event.toolCallId, result, running: false });
        }
        fold.view = null;
      } else if (event.kind === "session-end") {
        const fold = sessions.get(event.sessionId);
        if (!fold) continue;
        flushBuffer(event.sessionId);
        fold.meta.endedAt = event.ts;
        if (event.error) fold.meta.error = event.error;
        if (event.usage) fold.meta.usage = event.usage;
        fold.view = null;
      }
    }

    const views: DerivedSession[] = [];
    for (const [sessionId, fold] of sessions) {
      if (!fold.view) {
        // Sessions still streaming keep their buffer as a live tail item.
        const buffer = buffers.get(sessionId);
        const items = fold.items.slice();
        if (buffer) items.push({ type: buffer.kind, text: buffer.text, streaming: true });
        fold.view = { ...fold.meta, items };
      }
      views.push(fold.view);
    }
    return views;
  };

  return { append };
}
