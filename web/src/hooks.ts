import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getToken } from "./api";
import type { RunEvent } from "./types";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Bump to refetch; auto-retries after the previous load finished. */
  reload: () => void;
}

/**
 * Fetch-on-mount with 401 → /login redirection. The fetcher is stored in a
 * ref so callers can pass inline closures without re-triggering loads; the
 * reload counter is the explicit invalidation signal.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef.current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          navigate("/login");
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}

export type SseStatus = "idle" | "connecting" | "open" | "unavailable" | "closed" | "error";

/**
 * Server-sent events over fetch-streaming (so the Authorization header rides
 * along; EventSource cannot set headers). `onEvent` fires for every replayed
 * buffered event and every live event afterwards.
 */
export function useRunEvents(
  runId: string | null,
  enabled: boolean,
  onEvent: (event: RunEvent) => void,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>("idle");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || runId === null) {
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    let active = true;
    let attempts = 0;

    const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    const connect = async (): Promise<void> => {
      while (active) {
        setStatus("connecting");
        try {
          const token = getToken();
          const response = await fetch(`/api/events?runId=${encodeURIComponent(runId)}`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            if (response.status === 401) {
              if (active) setStatus("error");
              return;
            }
            if (active) setStatus("unavailable");
            return;
          }

          const { EventSourceParserStream } = await import("eventsource-parser/stream");
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream())
            .getReader();
          attempts = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!active) return;

            // eventsource-parser emits SSE event objects as { id, event, data }.
            // Older versions also expose stream-control objects with a type.
            const frame = value as { type?: string; data?: unknown };
            if (frame?.type !== undefined && frame.type !== "event") continue;
            if (typeof frame?.data !== "string" || frame.data.length === 0) continue;
            try {
              const event = JSON.parse(frame.data) as RunEvent;
              if (event.kind === "ready") {
                setStatus("open");
              } else if (event.kind === "unavailable") {
                setStatus("unavailable");
                return;
              } else {
                onEventRef.current(event);
              }
            } catch {
              // Ignore malformed frames; the next event resynchronizes.
            }
          }
          if (!active) return;
          setStatus("closed");
        } catch (cause) {
          if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
          setStatus("error");
        }

        attempts += 1;
        await wait(Math.min(1_000 * 2 ** Math.min(attempts - 1, 4), 10_000));
      }
    };

    void connect();

    return () => {
      active = false;
      controller.abort();
    };
  }, [runId, enabled]);

  return status;
}
