// Same-origin API client. The web token lives in localStorage and rides the
// Authorization header — never in URLs (SSE consumers use fetch-streaming,
// which supports headers, precisely to avoid ?token= leakage).

import type { FindingView, SessionTranscript } from "./types";

const TOKEN_KEY = "pir-web-token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode / disabled storage: the app still works per-session.
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly kind: "unauthorized" | "forbidden" | "missing" | "server" | "network";

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = status === 0 ? "network" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "missing" : "server";
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(cause instanceof Error ? `Network error: ${cause.message}` : "Network error", 0);
  }
  if (response.status === 401) throw new ApiError("unauthorized", 401);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // non-json error body
    }
    throw new ApiError(detail, response.status);
  }
  return response;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await request(path, { signal });
  return (await response.json()) as T;
}

export function transcriptUrl(projectId: string, runId: string, file: string): string {
  return `/api/runs/${projectId}/${runId}/transcript/${encodeURIComponent(file)}`;
}

// ---------------------------------------------------------------------------
// Small client-side caches. Timeline sections unmount their DOM when scrolled
// far away; these keep the fetched data so remounting is instant (and the
// server's ETag makes a forced refetch a bodyless 304 anyway).
// ---------------------------------------------------------------------------

const TRANSCRIPT_CACHE_LIMIT = 16;
const transcriptCache = new Map<string, SessionTranscript>();

/** Insertion-ordered Map as LRU: re-get refreshes recency. */
function cacheGet<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cachedTranscript(projectId: string, runId: string, file: string): SessionTranscript | undefined {
  return cacheGet(transcriptCache, `${projectId}/${runId}/${file}`);
}

export async function fetchTranscript(projectId: string, runId: string, file: string, signal?: AbortSignal): Promise<SessionTranscript> {
  const key = `${projectId}/${runId}/${file}`;
  const hit = cacheGet(transcriptCache, key);
  if (hit) return hit;
  const data = await apiGet<SessionTranscript>(transcriptUrl(projectId, runId, file), signal);
  cacheSet(transcriptCache, key, data, TRANSCRIPT_CACHE_LIMIT);
  return data;
}

const findingDetailCache = new Map<string, FindingView>();

export async function fetchFindingDetail(projectId: string, runId: string, findingId: string, signal?: AbortSignal): Promise<FindingView> {
  const key = `${projectId}/${runId}/${findingId}`;
  const hit = cacheGet(findingDetailCache, key);
  if (hit) return hit;
  const data = await apiGet<FindingView>(`/api/runs/${projectId}/${runId}/findings/${encodeURIComponent(findingId)}`, signal);
  cacheSet(findingDetailCache, key, data, 200);
  return data;
}
