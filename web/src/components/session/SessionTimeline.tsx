import { memo, useEffect, useRef, useState } from "react";
import { cachedTranscript, fetchTranscript } from "../../api";
import { fmtCost, fmtCount, fmtDuration } from "../../format";
import type { RunEvent, SessionRef, SessionTranscript, SessionUsage } from "../../types";
import { LiveBadge, SessionKindBadge } from "../badges";
import { TextBlockView, ThinkingRow, ToolRow, UserGoalCard } from "./blocks";
import { TranscriptView } from "./TranscriptView";

// ---------------------------------------------------------------------------
// Live derivation: fold the event stream of each session into render items.
// Deltas stream into a buffer; the authoritative session-block supersedes it.
// ---------------------------------------------------------------------------

type LiveItem =
  | { type: "thinking"; text: string; streaming: boolean }
  | { type: "text"; text: string; streaming: boolean }
  | { type: "tool"; name: string; args: unknown; callId: string; result?: { text: string; isError: boolean; truncated: boolean }; running: boolean };

interface DerivedSession {
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
        if (buffer && buffer.kind === event.deltaType) buffer.text += event.text;
        else {
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

/** Stateful wrapper: folds only the new tail of each liveEvents update. */
function useLiveSessions(events: RunEvent[] | null, runId: string): DerivedSession[] {
  const [sessions, setSessions] = useState<DerivedSession[]>([]);
  const foldRef = useRef<{ runId: string; fold: LiveFold } | null>(null);

  useEffect(() => {
    if (events === null || events.length === 0) {
      if (foldRef.current !== null) {
        foldRef.current = null;
        setSessions([]);
      }
      return;
    }
    if (foldRef.current?.runId !== runId) foldRef.current = { runId, fold: createLiveFold() };
    setSessions(foldRef.current.fold.append(events));
  }, [events, runId]);

  return sessions;
}

// ---------------------------------------------------------------------------
// Session sections: quiet divider, then the activity stream.
// ---------------------------------------------------------------------------

function sessionTitle(kind: string, meta: { round?: number; unitId?: string; attempt?: number; displayId?: string }): string {
  if (kind === "reviewer") {
    if (meta.unitId !== undefined) return `unit ${meta.unitId}${meta.attempt !== undefined ? ` · attempt ${meta.attempt}` : ""}`;
    return meta.round !== undefined ? `review round ${meta.round}` : "reviewer session";
  }
  return meta.displayId !== undefined ? `verify ${meta.displayId}` : "verifier session";
}

export function sessionDomId(session: Pick<SessionRef, "file"> | { sessionId: string }): string {
  const key = "file" in session ? session.file : session.sessionId;
  return `session-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function SessionDivider({
  kind,
  title,
  meta,
  state,
}: {
  kind: string;
  title: string;
  meta?: string;
  state?: "running" | "error" | "done";
}) {
  return (
    <div className={`pir-session-sep is-${state ?? "done"}`}>
      <span className="line" />
      <SessionKindBadge kind={kind} />
      <span className="title">{title}</span>
      {meta && <span className="meta">{meta}</span>}
      {state === "running" && <LiveBadge />}
      {state === "error" && <span className="font-mono text-[11px] text-red-400">error</span>}
      <span className="line" />
    </div>
  );
}

/** Activity stream of a live session (events already in memory). */
const LiveSessionSection = memo(function LiveSessionSection({ session }: { session: DerivedSession }) {
  const state: "running" | "error" | "done" = session.endedAt === null ? "running" : session.error ? "error" : "done";
  const meta = [
    session.model ?? "",
    session.endedAt !== null ? fmtDuration(session.endedAt - session.startedAt) : "",
    session.usage ? `${fmtCount(session.usage.totalTokens)} tok · ${fmtCost(session.usage.cost)}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <section className="session-flow-section" id={sessionDomId(session)} data-session-key={session.sessionId}>
      <SessionDivider kind={session.kind} title={sessionTitle(session.kind, session)} meta={meta} state={state} />
      <div className="session-flow">
        <UserGoalCard text={session.prompt} />
        <div className="assistant-turn">
          <div className="assistant-label">
            {session.role}
            {session.model && <span>{session.model}</span>}
          </div>
          <div className="session-flow-items">
            {session.items.map((item, index) => (
              <LiveItemView key={index} item={item} />
            ))}
          </div>
        </div>
        {session.error && (
          <div className="my-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">{session.error}</div>
        )}
      </div>
    </section>
  );
});

function LiveItemView({ item }: { item: LiveItem }) {
  if (item.type === "thinking") return <ThinkingRow text={item.text} streaming={item.streaming} />;
  if (item.type === "text") return <TextBlockView text={item.text} streaming={item.streaming} />;
  return <ToolRow name={item.name} args={item.args} result={item.result} running={item.running} />;
}

/** Mount window: sections inside this band render content, outside they don't. */
const NEAR_MARGIN = "1600px 0px 1600px 0px";
/** Placeholder height before the section has ever been measured. */
const UNVISITED_PLACEHOLDER_PX = 480;

/**
 * One settled session: divider + activity stream. Content mounts only inside
 * the near band — long runs have 100+ verifier sessions and nobody reads them
 * at once; far sections collapse to a height-pinned placeholder so the
 * scrollbar stays put, and the fetched transcript is cached for an instant
 * remount (the server answers a refetch with a bodyless 304 anyway).
 */
function TranscriptSessionSection({
  projectId,
  runId,
  session,
}: {
  projectId: string;
  runId: string;
  session: SessionRef;
}) {
  const [near, setNear] = useState(false);
  const [transcript, setTranscript] = useState<SessionTranscript | null | undefined>(
    () => cachedTranscript(projectId, runId, session.file),
  );
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near || transcript !== undefined) return;
    let cancelled = false;
    fetchTranscript(projectId, runId, session.file)
      .then((data) => {
        if (!cancelled) setTranscript(data);
      })
      .catch(() => {
        if (!cancelled) setTranscript(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId, session.file, near, transcript]);

  // Pin the measured height onto the placeholder so unmounting far sections
  // does not shift the scrollbar under the user.
  useEffect(() => {
    const element = contentRef.current;
    if (!near || element === null) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContentHeight(entry.target.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, transcript]);

  const meta = transcript?.usage
    ? `${fmtCount(transcript.usage.totalTokens)} tok · ${fmtCost(transcript.usage.cost)}`
    : session.file;

  return (
    <section className="session-flow-section" ref={sectionRef} id={sessionDomId(session)} data-session-key={session.file}>
      <SessionDivider
        kind={session.sessionKind}
        title={sessionTitle(session.sessionKind, session)}
        meta={meta}
        state={transcript === null ? "error" : "done"}
      />
      {near ? (
        <div className="session-flow" ref={contentRef}>
          {transcript === undefined && (
            <div className="py-6 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading session…</div>
          )}
          {transcript === null && (
            <div className="empty-state is-compact">Transcript file missing for <code>{session.file}</code>.</div>
          )}
          {transcript !== null && transcript !== undefined && <TranscriptView transcript={transcript} />}
        </div>
      ) : (
        <div
          className="session-flow-placeholder"
          style={{ height: contentHeight ?? UNVISITED_PLACEHOLDER_PX }}
          aria-hidden="true"
        />
      )}
    </section>
  );
}

export function SessionTimeline({
  projectId,
  runId,
  sessions,
  liveEvents,
  awaitingLive = false,
}: {
  projectId: string;
  runId: string;
  sessions: SessionRef[];
  liveEvents: RunEvent[] | null;
  /** Live run whose SSE replay has not landed yet: hold the spinner. */
  awaitingLive?: boolean;
}) {
  const liveSessions = useLiveSessions(liveEvents, runId);
  const useLive = liveSessions.length > 0;

  if (useLive) {
    return (
      <div className="session-timeline">
        {liveSessions.map((session) => (
          <LiveSessionSection key={session.sessionId} session={session} />
        ))}
      </div>
    );
  }

  if (awaitingLive) {
    return (
      <div className="loading-state is-compact" role="status">
        <span className="pir-mini-spinner" /> Connecting to live stream…
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="empty-state">
        No session transcripts for this run — it predates <code>PIR_TRANSCRIPTS=1</code>, or the
        session dump failed. Findings below are reconstructed from the repository memory.
      </div>
    );
  }

  return (
    <div className="session-timeline">
      {sessions.map((session) => (
        <TranscriptSessionSection key={session.file} projectId={projectId} runId={runId} session={session} />
      ))}
    </div>
  );
}
