import { useMemo, useState } from "react";
import { apiGet, transcriptUrl } from "../../api";
import { fmtCost, fmtCount, fmtDuration } from "../../format";
import { useApi } from "../../hooks";
import type { LiveSessionState, RunEvent, SessionRef, SessionTranscript, SessionUsage } from "../../types";
import { SessionKindBadge } from "../badges";
import { TextBlockView, ThinkingBlock, ToolCallView, UserPromptBlock } from "./blocks";
import { TranscriptView } from "./TranscriptView";

// ---------------------------------------------------------------------------
// Live derivation: fold the event stream of one session into render items.
// Deltas stream into a buffer; the authoritative session-block supersedes it.
// ---------------------------------------------------------------------------

type LiveItem =
  | { type: "thinking"; text: string; streaming: boolean }
  | { type: "text"; text: string; streaming: boolean }
  | { type: "tool"; call: { id: string; name: string; arguments: unknown }; result?: { text: string; isError: boolean; truncated: boolean }; running: boolean };

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
        session.items.push({ type: "tool", call: { id: block.id, name: block.name, arguments: block.arguments }, running: true });
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
      const open = [...session.items].reverse().find((item) => item.type === "tool" && item.call.id === event.toolCallId);
      if (open && open.type === "tool") {
        open.result = { text: event.result, isError: event.isError, truncated: event.truncated };
        open.running = false;
      } else {
        session.items.push({
          type: "tool",
          call: { id: event.toolCallId, name: event.name, arguments: {} },
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
// Session nodes
// ---------------------------------------------------------------------------

function sessionTitle(kind: string, meta: { round?: number; unitId?: string; attempt?: number; displayId?: string }): string {
  if (kind === "reviewer") {
    if (meta.unitId !== undefined) return `Unit ${meta.unitId}${meta.attempt !== undefined ? ` · attempt ${meta.attempt}` : ""}`;
    return meta.round !== undefined ? `Review round ${meta.round}` : "Reviewer session";
  }
  return meta.displayId !== undefined ? `Verify ${meta.displayId}` : "Verifier session";
}

function LiveSessionNode({ session, defaultOpen }: { session: DerivedSession; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`session-node ${session.kind}${session.endedAt === null ? " active" : ""}${session.error ? " error" : ""}`}>
      <div className="session-card live" style={session.endedAt === null ? { borderColor: "var(--ok)" } : undefined}>
        <div className="session-head" onClick={() => setOpen(!open)}>
          <SessionKindBadge kind={session.kind} />
          <span className="title">{sessionTitle(session.kind, session)}</span>
          <span className="meta">{session.model ?? ""}</span>
          <span className="spacer" />
          {session.endedAt === null
            ? <span className="live-pill"><span className="pulse" />running</span>
            : session.error
              ? <span className="badge status-failed">error</span>
              : <span className="meta">{fmtDuration(session.endedAt - session.startedAt)}</span>}
          <span className={`chevron${open ? " open" : ""}`}>▶</span>
        </div>
        {open && (
          <div className="session-body">
            <div className="chat">
              <UserPromptBlock prompt={session.prompt} />
              {session.items.map((item, index) => (
                <LiveItemView key={index} item={item} />
              ))}
              {session.usage && (
                <div className="stat-row">
                  <span className="stat"><b>{fmtCount(session.usage.totalTokens)}</b> tokens</span>
                  <span className="stat"><b>{fmtCost(session.usage.cost)}</b></span>
                  <span className="stat"><b>{session.usage.toolCalls ?? 0}</b> tool calls</span>
                </div>
              )}
              {session.error && <div className="error-banner" style={{ marginBottom: 0 }}>{session.error}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveItemView({ item }: { item: LiveItem }) {
  if (item.type === "thinking") return <ThinkingBlock text={item.text} streaming={item.streaming} />;
  if (item.type === "text") return <TextBlockView text={item.text} streaming={item.streaming} />;
  return <ToolCallView call={item.call} result={item.result} running={item.running} />;
}

function TranscriptSessionNode({
  projectId,
  runId,
  session,
  defaultOpen,
}: {
  projectId: string;
  runId: string;
  session: SessionRef;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [cache, setCache] = useState<SessionTranscript | null | undefined>(undefined);
  const transcript = useApi<SessionTranscript | null>(
    async () => {
      if (cache !== undefined) return cache;
      try {
        const data = await apiGet<SessionTranscript>(transcriptUrl(projectId, runId, session.file));
        setCache(data);
        return data;
      } catch {
        setCache(null);
        return null;
      }
    },
    [projectId, runId, session.file, open],
  );

  return (
    <div className={`session-node ${session.sessionKind}`}>
      <div className="session-card">
        <div className="session-head" onClick={() => setOpen(!open)}>
          <SessionKindBadge kind={session.sessionKind} />
          <span className="title">{sessionTitle(session.sessionKind, session)}</span>
          <span className="meta">{session.file}</span>
          <span className="spacer" />
          {open && transcript.data?.usage && (
            <span className="meta">
              {fmtCount(transcript.data.usage.totalTokens)} tok · {fmtCost(transcript.data.usage.cost)}
            </span>
          )}
          {open && transcript.loading && <span className="spinner" />}
          <span className={`chevron${open ? " open" : ""}`}>▶</span>
        </div>
        {open && (
          <div className="session-body">
            {transcript.loading && !transcript.data && <div className="loading-row"><span className="spinner" /></div>}
            {transcript.data && <TranscriptView transcript={transcript.data} />}
            {transcript.data === null && !transcript.loading && (
              <div className="empty-state" style={{ padding: 16 }}>
                Transcript file missing for <code>{session.file}</code>.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
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
      <div className="timeline">
        {liveSessions.map((session, index) => (
          <LiveSessionNode key={session.sessionId} session={session} defaultOpen={index === liveSessions.length - 1} />
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
    <div className="timeline">
      {sessions.map((session, index) => (
        <TranscriptSessionNode key={session.file} projectId={projectId} runId={runId} session={session} defaultOpen={index === 0} />
      ))}
    </div>
  );
}

export type { LiveSessionState };
