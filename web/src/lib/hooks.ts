import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, describeError, getToken } from "./api";
import type { RunEvent } from "./types";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  errorStatus: number | null;
  loading: boolean;
  /** True while the held data answers a previous resource or query. */
  stale: boolean;
  reload: () => void;
}

export interface ApiOptions {
  /**
   * Deps whose change replaces the displayed resource. Data is discarded only
   * for these; other deps keep the held rows visible while a new request is in
   * flight, so a filter or page change does not unmount the table (and lose
   * keyboard focus). Defaults to all deps.
   */
  identity?: unknown[];
}

/**
 * Fetch-on-mount with 401 → /login. Every resource identity owns an
 * AbortController, so route changes cancel work and a late response cannot
 * populate the next resource. The reload counter is the explicit invalidation
 * signal; `stale` lets a page keep showing the previous snapshot during a
 * background recalibration.
 */
export function useApi<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[], options: ApiOptions = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedIdentity = useRef<string | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const identityKey = JSON.stringify(options.identity ?? deps);
  const resourceKey = JSON.stringify(deps);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const identityChanged = loadedIdentity.current !== identityKey;
    loadedIdentity.current = identityKey;
    if (identityChanged) {
      setData(null);
      setErrorStatus(null);
    }
    setError(null);
    setLoading(true);
    fetcher(controller.signal)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        setErrorStatus(null);
        setSettledKey(resourceKey);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (cause instanceof ApiError && cause.status === 401) {
          const current = locationRef.current;
          navigate("/login", {
            replace: true,
            state: { from: `${current.pathname}${current.search}${current.hash}` },
          });
          return;
        }
        setError(describeError(cause));
        setErrorStatus(cause instanceof ApiError ? cause.status : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  // The fetcher closure is intentionally not a dependency: callers encode the
  // resource in the deps array (the old hook's contract, plus identity).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  if (loadedIdentity.current !== identityKey) return { data: null, error: null, errorStatus: null, loading: true, stale: false, reload };
  return { data, error, errorStatus, loading, stale: settledKey !== resourceKey, reload };
}

export type SseStatus = "idle" | "connecting" | "open" | "unavailable" | "closed" | "error" | "unauthorized";

/**
 * Server-sent events over fetch-streaming, with reconnect and no 401 retry
 * loop. The callback receives every replayed and live event; ordering and
 * run identity remain the caller's responsibility.
 */
export function useRunEvents(
  runId: string | null,
  enabled: boolean,
  onEvent: (event: RunEvent) => void,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>("idle");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

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
          if (!active) return;
          if (!response.ok || !response.body) {
            if (response.status === 401) {
              setStatus("unauthorized");
              const current = locationRef.current;
              navigate("/login", { replace: true, state: { from: `${current.pathname}${current.search}${current.hash}` } });
              return;
            }
            throw new ApiError("Live stream could not connect", response.status);
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
            const frame = value as { type?: string; data?: unknown };
            if (frame?.type !== undefined && frame.type !== "event") continue;
            if (typeof frame?.data !== "string" || frame.data.length === 0) continue;
            try {
              const event = JSON.parse(frame.data) as RunEvent;
              if (event.kind === "ready") {
                setStatus("open");
                onEventRef.current(event);
              } else if (event.kind === "unavailable") {
                setStatus("unavailable");
                onEventRef.current(event);
                await reader.cancel();
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
  }, [runId, enabled, navigate]);

  return status;
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
