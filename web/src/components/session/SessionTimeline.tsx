import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, transcriptUrl } from "../../api";
import { fmtCost, fmtCount, fmtDuration } from "../../format";
import type { RunEvent, SessionRef, SessionTranscript, SessionUsage } from "../../types";
import { LiveBadge, SessionKindBadge } from "../badges";
import { TextBlockView, ThinkingRow, ToolRow, UserGoalCard } from "./blocks";
import { TranscriptView } from "./TranscriptView";

// ---------------------------------------------------------------------------
// Live derivation: fold the event stream of one session into render items.
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

export function deriveLiveSessions(events: RunEvent[]): DerivedSession[] {
  const sessions = new Map<string, DerivedSession>();
  const buffers = new Map<string, { kind: "thinking" | "text"; text: string }>();

  const flush = (sessionId: string): void => {
    const buffer = buffers.get(sessionId);
    if (!buffer) return;
    buffers.delete(sessionId);
    const session = sessions.get(sessionId);
    if (session) session.items.push({ type: buffer.kind, text: buffer.text, streaming: false });
  };

  for (const event of events) {
    if (event.kind === "session-start") {
      sessions.set(event.sessionId, {
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
        items: [],
      });
    } else if (event.kind === "session-delta") {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      const buffer = buffers.get(event.sessionId);
      if (buffer && buffer.kind === event.deltaType) buffer.text += event.text;
      else {
        flush(event.sessionId);
        buffers.set(event.sessionId, { kind: event.deltaType, text: event.text });
      }
    } else if (event.kind === "session-block") {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      const block = event.block;
      if (block.type === "toolCall") {
        flush(event.sessionId);
        session.items.push({ type: "tool", name: block.name, args: block.arguments, callId: block.id, running: true });
      } else {
        const buffer = buffers.get(event.sessionId);
        const kind = block.type === "thinking" ? "thinking" : "text";
        if (!buffer || buffer.kind !== kind) flush(event.sessionId);
        else buffers.delete(event.sessionId); // streamed content settles into the block
        if (block.type === "thinking") {
          session.items.push({ type: "thinking", text: block.text, streaming: false });
        } else {
          session.items.push({ type: "text", text: block.text, streaming: false });
        }
      }
    } else if (event.kind === "session-tool-result") {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      const open = [...session.items].reverse().find((item) => item.type === "tool" && item.callId === event.toolCallId);
      if (open && open.type === "tool") {
        open.result = { text: event.result, isError: event.isError, truncated: event.truncated };
        open.running = false;
      } else {
        session.items.push({
          type: "tool", name: event.name, args: {}, callId: event.toolCallId,
          result: { text: event.result, isError: event.isError, truncated: event.truncated },
          running: false,
        });
      }
    } else if (event.kind === "session-end") {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      flush(event.sessionId);
      session.endedAt = event.ts;
      if (event.error) session.error = event.error;
      if (event.usage) session.usage = event.usage;
    }
  }
  // Sessions still streaming keep their buffer as a live tail item.
  for (const [sessionId, buffer] of buffers) {
    const session = sessions.get(sessionId);
    if (session) session.items.push({ type: buffer.kind, text: buffer.text, streaming: true });
  }
  return [...sessions.values()];
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
function LiveSessionSection({ session }: { session: DerivedSession }) {
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
}

function LiveItemView({ item }: { item: LiveItem }) {
  if (item.type === "thinking") return <ThinkingRow text={item.text} streaming={item.streaming} />;
  if (item.type === "text") return <TextBlockView text={item.text} streaming={item.streaming} />;
  return <ToolRow name={item.name} args={item.args} result={item.result} running={item.running} />;
}

/**
 * One settled session: divider + activity stream. The transcript JSON is
 * fetched only when the section scrolls near the viewport — long runs have
 * many verifier sessions and nobody reads them all at once.
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
  const [open] = useState(true);
  const [visible, setVisible] = useState(false);
  const [transcript, setTranscript] = useState<SessionTranscript | null | undefined>(undefined);
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || visible || transcript !== undefined) return;
    const element = sectionRef.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, visible, transcript]);

  useEffect(() => {
    if (!open || !visible || transcript !== undefined) return;
    let cancelled = false;
    apiGet<SessionTranscript>(transcriptUrl(projectId, runId, session.file))
      .then((data) => {
        if (!cancelled) setTranscript(data);
      })
      .catch(() => {
        if (!cancelled) setTranscript(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId, session.file, open, visible, transcript]);

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
      {open && (
        <div className="session-flow">
          {transcript === undefined && (
            <div className="py-6 text-center text-muted-foreground"><span className="pir-mini-spinner" /> loading session…</div>
          )}
          {transcript === null && (
            <div className="empty-state is-compact">Transcript file missing for <code>{session.file}</code>.</div>
          )}
          {transcript !== null && transcript !== undefined && <TranscriptView transcript={transcript} />}
        </div>
      )}
    </section>
  );
}

export function SessionTimeline({
  projectId,
  runId,
  sessions,
  liveEvents,
}: {
  projectId: string;
  runId: string;
  sessions: SessionRef[];
  liveEvents: RunEvent[] | null;
}) {
  const liveSessions = useMemo(() => (liveEvents ? deriveLiveSessions(liveEvents) : []), [liveEvents]);
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
