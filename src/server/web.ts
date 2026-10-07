import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  findingById,
  listFindings,
  listProjects,
  listRuns,
  readTranscript,
  recentFeedback,
  runDetail,
} from "./web-store.js";
import type { LiveRegistry } from "./live-registry.js";

/**
 * Read-only web UI mounted into the pir serve handler when PIR_WEB_UI is on.
 * GET-only by construction: every /api route is a read; anything else is a
 * static asset or the SPA shell. Mutating verbs answer 405 so the surface is
 * auditable: the web tier can never start a review.
 */

export interface WebUiConfig {
  /** PIR_WEB_UI_TOKEN; undefined means loopback-open mode (logged loudly). */
  token?: string;
  stateRoot: string;
  /** Static SPA directory (dist/web). */
  webRoot: string;
  registry: LiveRegistry;
}

export function defaultWebRoot(): string {
  const override = process.env.PIR_WEB_ROOT;
  if (override) return override;
  // dist/server/web.js -> dist/web
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NO_ASSETS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>pir web</title>
<style>body{font-family:ui-monospace,monospace;background:#111418;color:#cfd6e4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{max-width:32rem;padding:2rem;border:1px solid #2a313c;border-radius:8px}</style></head>
<body><div><h1>pir web</h1><p>The web assets are not built in this install.
Run <code>npm run build</code> in the pir package (or set <code>PIR_WEB_ROOT</code> to a built <code>dist/web</code>) and restart <code>pir serve</code>.
The read-only JSON API under <code>/api/</code> is available.</p></div></body></html>`;

/** JSON bodies below this size cost more to negotiate than they save. */
const COMPRESS_MIN_BYTES = 1024;

function acceptsGzip(req: http.IncomingMessage): boolean {
  return /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
}

/**
 * Send a complete body, gzip-compressed when the client accepts it. Same sync
 * posture the handlers already have; SSE streams bypass this (flush latency).
 */
function sendBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  code: number,
  body: Buffer | string,
  headers: Record<string, string>,
): void {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (acceptsGzip(req) && buffer.length >= COMPRESS_MIN_BYTES) {
    const compressed = gzipSync(buffer);
    res.writeHead(code, { ...headers, "content-encoding": "gzip", "content-length": String(compressed.length) });
    res.end(compressed);
    return;
  }
  res.writeHead(code, headers);
  res.end(buffer);
}

function json(req: http.IncomingMessage, res: http.ServerResponse, code: number, payload: unknown): void {
  if (code === 304) {
    res.writeHead(304, { "cache-control": "no-cache" });
    res.end();
    return;
  }
  sendBody(req, res, code, JSON.stringify(payload), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
}

function isAuthorized(headers: http.IncomingMessage["headers"], token: string | undefined): boolean {
  if (!token) return true;
  const header = headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const received = Buffer.from(header, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/** Textual assets worth compressing; woff2/png/ico are already compact. */
const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".map"]);

async function serveStatic(webRoot: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!existsSync(webRoot)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(NO_ASSETS_PAGE);
    return;
  }
  let relative: string;
  try {
    // Malformed escapes (a lone "%", "%zz") survive URL parsing untouched and
    // make decodeURIComponent throw — that must answer 400, not escape the
    // request listener (an unhandled throw there kills the whole server).
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    json(req, res, 400, { error: "malformed request path" });
    return;
  }
  const resolved = path.resolve(webRoot, relative);
  if (!resolved.startsWith(`${webRoot}${path.sep}`) && resolved !== webRoot) {
    json(req, res, 404, { error: "not found" });
    return;
  }
  let stats: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    stats = await stat(resolved);
  } catch {
    stats = undefined;
  }
  if (stats?.isFile()) {
    const ext = path.extname(resolved);
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const headers = { "content-type": type, "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600" };
    try {
      const content = await readFile(resolved);
      if (COMPRESSIBLE_EXTS.has(ext)) sendBody(req, res, 200, content, headers);
      else {
        res.writeHead(200, headers);
        res.end(content);
      }
    } catch {
      json(req, res, 404, { error: "not found" });
    }
    return;
  }
  const indexFile = path.join(webRoot, "index.html");
  if (existsSync(indexFile)) {
    try {
      sendBody(req, res, 200, await readFile(indexFile), { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    } catch {
      json(req, res, 404, { error: "not found" });
    }
    return;
  }
  json(req, res, 404, { error: "not found" });
}

function startSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: LiveRegistry,
  runId: string | null,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  res.write("retry: 3000\n\n");
  if (runId) {
    const known = registry.snapshot(runId);
    if (!known) {
      // Unknown/stale run: tell the client to fall back to the REST detail.
      send({ kind: "unavailable", runId });
      res.end();
      return;
    }
  }
  const { replay, unsubscribe } = registry.subscribe(runId, send);
  for (const event of replay) send(event);
  send({ kind: "ready", runId });
  const heartbeat = setInterval((): void => {
    res.write(": ping\n\n");
  }, 15_000);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

export interface WebUi {
  /** Returns true when the request was answered (caller must not continue). */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string): boolean;
  log: (message: string) => void;
}

export function createWebUi(config: WebUiConfig): WebUi {
  const log = (message: string): void => {
    process.stderr.write(`[pir-serve ${new Date().toISOString()}] web: ${message}\n`);
  };
  const stateRoot = config.stateRoot;

  const handleApi = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, method: string): boolean => {
    if (!url.pathname.startsWith("/api/")) return false;
    if (method !== "GET" && method !== "HEAD") {
      json(req, res, 405, { error: "the web endpoint is read-only" });
      return true;
    }
    if (!isAuthorized(req.headers, config.token)) {
      json(req, res, 401, { error: "missing or invalid bearer token" });
      return true;
    }

    const parts = url.pathname.slice("/api/".length).split("/").filter(Boolean);

    if (method === "GET" && parts[0] === "events") {
      const runId = url.searchParams.get("runId");
      if (runId !== null && !/^[\w-]+$/.test(runId)) {
        json(req, res, 400, { error: "invalid runId" });
        return true;
      }
      startSse(req, res, config.registry, runId);
      return true;
    }

    if (parts[0] === "overview" && parts.length === 1) {
      json(req, res, 200, { projects: listProjects(stateRoot), active: config.registry.activeRuns() });
      return true;
    }

    if (parts[0] === "projects" && parts.length === 3 && parts[2] === "runs") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const status = url.searchParams.get("status") ?? undefined;
      const result = listRuns(parts[1]!, { limit, offset, ...(status ? { status } : {}) }, stateRoot);
      if (!result) {
        json(req, res, 404, { error: "unknown project" });
        return true;
      }
      json(req, res, 200, result);
      return true;
    }

    if (parts[0] === "projects" && parts.length === 3 && parts[2] === "feedback") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const result = recentFeedback(parts[1]!, limit, stateRoot);
      if (!result) {
        json(req, res, 404, { error: "unknown project" });
        return true;
      }
      json(req, res, 200, { events: result });
      return true;
    }

    if (parts[0] === "runs" && parts.length === 4 && parts[3] === "findings") {
      // Non-numeric limit/offset would reach sqlite as NaN and throw; treat
      // them as absent the way missing params behave.
      const limitParam = Number(url.searchParams.get("limit"));
      const offsetParam = Number(url.searchParams.get("offset"));
      const result = listFindings(parts[1]!, parts[2]!, {
        ...(Number.isFinite(limitParam) && limitParam > 0 ? { limit: limitParam } : {}),
        ...(Number.isFinite(offsetParam) && offsetParam >= 0 ? { offset: offsetParam } : {}),
      }, stateRoot);
      if (!result) {
        json(req, res, 404, { error: "unknown run" });
        return true;
      }
      json(req, res, 200, { findings: result.items, total: result.total });
      return true;
    }

    if (parts[0] === "runs" && parts.length === 5 && parts[3] === "findings") {
      const finding = findingById(parts[1]!, parts[2]!, parts[4]!, stateRoot);
      if (!finding) {
        json(req, res, 404, { error: "unknown finding" });
        return true;
      }
      json(req, res, 200, finding);
      return true;
    }

    if (parts[0] === "runs" && parts.length === 5 && parts[3] === "transcript") {
      void readTranscript(parts[1]!, parts[2]!, parts[4]!, stateRoot).then((transcript) => {
        if (transcript === null) {
          json(req, res, 404, { error: "transcript not found" });
          return;
        }
        // Transcripts are immutable once written: revalidation is always safe
        // and a 304 saves the whole body on revisit.
        if (req.headers["if-none-match"] === transcript.etag) {
          res.writeHead(304, { etag: transcript.etag, "cache-control": "no-cache" });
          res.end();
          return;
        }
        sendBody(req, res, 200, JSON.stringify(transcript.payload), {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache",
          etag: transcript.etag,
        });
      });
      return true;
    }

    if (parts[0] === "runs" && parts.length === 3) {
      const detail = runDetail(parts[1]!, parts[2]!, stateRoot);
      if (!detail) {
        json(req, res, 404, { error: "unknown run" });
        return true;
      }
      // Live event replay rides the SSE channel alone; the REST snapshot
      // carries only the metadata (sessions/end/counts) so a mid-run join
      // does not download the whole buffer twice.
      const live = config.registry.snapshot(parts[2]!);
      const liveMeta = live === null ? null : (({ events: _replayed, ...meta }) => meta)(live);
      json(req, res, 200, { ...detail, ...(liveMeta ? { live: liveMeta } : {}) });
      return true;
    }

    json(req, res, 404, { error: "unknown api endpoint" });
    return true;
  };

  return {
    log,
    handle(req, res, url, method) {
      if (url.pathname.startsWith("/api/")) {
        return handleApi(req, res, url, method);
      }
      if (method === "GET" || method === "HEAD") {
        void serveStatic(config.webRoot, url.pathname, req, res);
        return true;
      }
      return false;
    },
  };
}
