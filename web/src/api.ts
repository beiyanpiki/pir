// Same-origin API client. The web token lives in localStorage and rides the
// Authorization header — never in URLs (SSE consumers use fetch-streaming,
// which supports headers, precisely to avoid ?token= leakage).

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

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
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

export async function apiGet<T>(path: string): Promise<T> {
  const response = await request(path);
  return (await response.json()) as T;
}

export function transcriptUrl(projectId: string, runId: string, file: string): string {
  return `/api/runs/${projectId}/${runId}/transcript/${encodeURIComponent(file)}`;
}
