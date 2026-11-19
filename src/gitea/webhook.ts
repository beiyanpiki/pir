import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Gitea webhook ingress primitives: HMAC signature verification over the raw
 * request body, event routing headers, and a defensive typed view of the
 * pull-request payload. Pure parsing — no I/O beyond the buffers handed in —
 * so the endpoint that lands later can unit-test everything through here.
 */

/** Usage-style error for webhook requests that cannot be routed at all. */
export class GiteaWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiteaWebhookError";
  }
}

/** Headers as a plain object, case-insensitively matched (Node lowercases incoming ones already). */
type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string") return undefined;
    const trimmed = first.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

/** SHA-256 hex digests are always 64 ASCII chars; anything else is not a signature we compare. */
const HEX_SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * The digest a request actually carried: `x-gitea-signature` (bare hex) wins,
 * `x-hub-signature-256` (`sha256=<hex>`, the GitHub-compatible form Gitea also
 * sends) is the fallback. Absent, empty, or malformed values are null — there
 * is nothing to compare, so the request is rejected rather than erroring.
 */
function providedDigest(headers: Headers): string | null {
  const gitea = headerValue(headers, "x-gitea-signature");
  if (gitea !== undefined) {
    return HEX_SHA256_RE.test(gitea) ? gitea.toLowerCase() : null;
  }
  const hub = headerValue(headers, "x-hub-signature-256");
  if (hub === undefined) return null;
  const digest = hub.toLowerCase().startsWith("sha256=") ? hub.slice("sha256=".length) : hub;
  return HEX_SHA256_RE.test(digest) ? digest.toLowerCase() : null;
}

/**
 * Constant-time HMAC-SHA256 check over the RAW body bytes — the exact bytes
 * the transport received, not a re-serialized JSON object. Like the bearer
 * check in the exec server, length is compared first because
 * timingSafeEqual rejects mismatched buffer lengths.
 */
export function verifyGiteaSignature(
  rawBody: Buffer | string,
  secret: string,
  headers: Headers,
): boolean {
  const provided = providedDigest(headers);
  if (provided === null) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(provided, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (received.length !== wanted.length) return false;
  return timingSafeEqual(received, wanted);
}

/** Event routing headers: `x-gitea-event` (e.g. `pull_request`) and the exact trigger `x-gitea-event-type` (e.g. `pull_request_sync`). */
export interface GiteaEventHeaders {
  event: string;
  /** Exact webhook type; null when Gitea did not send the header (older instances). */
  eventType: string | null;
}

/** Extract `{event, eventType}` from webhook headers; a request without `x-gitea-event` cannot be routed. */
export function parseGiteaEvent(headers: Headers): GiteaEventHeaders {
  const event = headerValue(headers, "x-gitea-event");
  if (event === undefined) {
    throw new GiteaWebhookError("missing x-gitea-event header — cannot route webhook");
  }
  return { event, eventType: headerValue(headers, "x-gitea-event-type") ?? null };
}

/**
 * Defensive typed view of a Gitea pull-request webhook payload: unknown extra
 * fields are ignored, missing required fields are a GiteaWebhookError instead
 * of a downstream undefined deref. Gitea reuses this payload shape for the
 * `pull_request` (generic) and `pull_request_sync` webhook types.
 */
export interface GiteaPullRequestView {
  action: string;
  number: number;
  title: string;
  /** Gitea sends null for an empty PR body; normalized to "". */
  body: string;
  /** True only when the payload explicitly says so (older Gitea omits it). */
  draft?: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  /** Where to clone the PR head: head repo clone_url, falling back to ssh_url, then the base repository. */
  cloneUrl: string;
  /** `owner/name`, from repository.full_name with an owner+name fallback. */
  repoFullName: string;
  labels: string[];
  senderLogin: string;
  prUser: string;
}

/**
 * Discriminated webhook event for the endpoint router: PR-carrying events get
 * the parsed view, everything else is `payload: null` and skipped cheaply.
 */
export type GiteaWebhookEvent =
  | { event: "pull_request"; eventType: string | null; payload: GiteaPullRequestView }
  | { event: "pull_request_sync"; eventType: string | null; payload: GiteaPullRequestView }
  | { event: string; eventType: string | null; payload: null };

/** Type guard for the two PR-carrying Gitea events pir reviews. */
export function isPullRequestEvent(
  event: GiteaWebhookEvent,
): event is Extract<GiteaWebhookEvent, { payload: GiteaPullRequestView }> {
  return event.payload !== null;
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GiteaWebhookError(`${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) {
    throw new GiteaWebhookError(`${context}: expected a non-empty string`);
  }
  return value;
}

/** First non-empty string among candidates, or a GiteaWebhookError naming the context. */
function requireFirstString(candidates: Array<[unknown, string]>, context: string): string {
  for (const [value, field] of candidates) {
    if (typeof value === "string" && value) return value;
  }
  throw new GiteaWebhookError(`${context}: no ${context} available`);
}

/** Parse the raw webhook body into a GiteaPullRequestView; malformed payloads throw instead of half-parsing. */
export function parsePullRequestPayload(rawBody: Buffer | string): GiteaPullRequestView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    throw new GiteaWebhookError("webhook body is not valid JSON");
  }
  const root = requireObject(parsed, "payload");
  const action = requireString(root.action, "payload.action");
  const numberValue = root.number;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new GiteaWebhookError("payload.number: expected a positive integer pull request index");
  }
  const pr = requireObject(root.pull_request, "payload.pull_request");
  const title = requireString(pr.title, "payload.pull_request.title");
  const base = requireObject(pr.base, "payload.pull_request.base");
  const head = requireObject(pr.head, "payload.pull_request.head");
  const repository = requireObject(root.repository, "payload.repository");
  const sender = requireObject(root.sender, "payload.sender");
  const prUser = requireObject(pr.user, "payload.pull_request.user");

  const repoOwner = requireObject(repository.owner, "payload.repository.owner");
  const repoFullName = requireFirstString(
    [
      [repository.full_name, "full_name"],
      [
        typeof repoOwner.login === "string" && typeof repository.name === "string"
          ? `${repoOwner.login}/${repository.name}`
          : undefined,
        "owner/login + name",
      ],
    ],
    "payload.repository repo full name",
  );

  // The PR head is what gets cloned and reviewed, so the head repo wins; the
  // top-level repository is the same repo for same-repo PRs and the fallback
  // when a bare-bones payload omits head.repo.
  const headRepo = typeof head.repo === "object" && head.repo !== null ? requireObject(head.repo, "payload.pull_request.head.repo") : null;
  const cloneUrl = requireFirstString(
    [
      [headRepo?.clone_url, "clone_url"],
      [headRepo?.ssh_url, "ssh_url"],
      [repository.clone_url, "clone_url"],
      [repository.ssh_url, "ssh_url"],
    ],
    "payload clone URL",
  );

  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((label, i) =>
        requireString(requireObject(label, `payload.pull_request.labels[${i}]`).name, `payload.pull_request.labels[${i}].name`),
      )
    : [];

  return {
    action,
    number: numberValue,
    title,
    body: typeof pr.body === "string" ? pr.body : "",
    ...(typeof pr.draft === "boolean" ? { draft: pr.draft } : {}),
    baseRef: requireString(base.ref, "payload.pull_request.base.ref"),
    baseSha: requireString(base.sha, "payload.pull_request.base.sha"),
    headRef: requireString(head.ref, "payload.pull_request.head.ref"),
    headSha: requireString(head.sha, "payload.pull_request.head.sha"),
    htmlUrl: requireString(pr.html_url, "payload.pull_request.html_url"),
    cloneUrl,
    repoFullName,
    labels,
    senderLogin: requireString(sender.login, "payload.sender.login"),
    prUser: requireString(prUser.login, "payload.pull_request.user.login"),
  };
}
