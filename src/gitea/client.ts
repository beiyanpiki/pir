/**
 * Minimal Gitea API client for the PR review integration: reviews (create,
 * list, delete), PR conversation comments (issue comments), and commit
 * statuses. fetchImpl is injectable so tests script responses without a
 * network; the default is the global fetch (Node's undici).
 */

/** Typed failure for any non-2xx Gitea response: HTTP status, message, and the parsed body for diagnostics. */
export class GiteaApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "GiteaApiError";
    this.status = status;
    this.body = body;
  }
}

/** Injectable fetch — the global fetch signature, so tests can pass a plain async function. */
export type GiteaFetch = typeof fetch;

export interface GiteaClientOptions {
  /** Instance base URL, e.g. https://gitea.example.com (trailing slashes tolerated). */
  baseUrl: string;
  /** API token sent as `Authorization: token <token>`. */
  token: string;
  fetchImpl?: GiteaFetch;
}

/** One inline review comment pinned to the PR head (Gitea: new_position is the head-side line). */
export interface GiteaReviewCommentInput {
  body: string;
  path?: string;
  new_position?: number;
}

export interface GiteaReviewInput {
  body: string;
  /** Gitea review event; pir only ever posts COMMENT reviews — findings are advisory, not blocking. */
  event?: "COMMENT";
  comments: GiteaReviewCommentInput[];
}

export interface GiteaReview {
  id: number;
  user?: { login?: string };
  body?: string;
}

export interface GiteaIssueComment {
  id: number;
  user?: { login?: string };
  body?: string;
}

export type GiteaCommitStatusState = "pending" | "success" | "failure" | "error";

export interface GiteaCommitStatusInput {
  state: GiteaCommitStatusState;
  /** Status line label, e.g. "pir/review". */
  context: string;
  description: string;
  target_url?: string;
}

export interface GiteaClient {
  createReview(owner: string, repo: string, prIndex: number, input: GiteaReviewInput): Promise<{ id: number }>;
  listReviews(owner: string, repo: string, prIndex: number): Promise<GiteaReview[]>;
  deleteReview(owner: string, repo: string, prIndex: number, id: number): Promise<void>;
  listIssueComments(owner: string, repo: string, prIndex: number): Promise<GiteaIssueComment[]>;
  createIssueComment(owner: string, repo: string, prIndex: number, body: string): Promise<{ id: number }>;
  editIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GiteaIssueComment>;
  createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    input: GiteaCommitStatusInput,
  ): Promise<Record<string, unknown>>;
}

/** Pull the human-readable message out of a Gitea error body ({message, url} is Gitea's error shape). */
function apiErrorFrom(status: number, body: unknown): GiteaApiError {
  let message = `Gitea API ${status}`;
  if (typeof body === "string" && body.trim()) {
    message = body.trim().slice(0, 400);
  } else if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).message === "string"
  ) {
    message = (body as Record<string, unknown>).message as string;
  }
  return new GiteaApiError(status, message, body);
}

export function createGiteaClient(options: GiteaClientOptions): GiteaClient {
  // Strip trailing slashes so "<base>/repos/…" joins never produce "//".
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function request(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          authorization: `token ${options.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // Transport failures (DNS, refused, TLS) surface as-is; only Gitea's
      // HTTP answers become GiteaApiError so callers can tell the two apart.
      throw err instanceof Error ? err : new Error(String(err));
    }
    const text = await response.text().catch(() => "");
    const parsed: unknown = text ? safeJsonParse(text) : null;
    if (!response.ok) {
      throw apiErrorFrom(response.status, parsed ?? text);
    }
    // 204 (deleteReview) and empty 2xx bodies have nothing to parse.
    return parsed;
  }

  return {
    async createReview(owner, repo, prIndex, input) {
      const out = await request("POST", `/repos/${owner}/${repo}/pulls/${prIndex}/reviews`, {
        body: input.body,
        event: input.event ?? "COMMENT",
        comments: input.comments,
      });
      return out as { id: number };
    },
    async listReviews(owner, repo, prIndex) {
      const out = await request("GET", `/repos/${owner}/${repo}/pulls/${prIndex}/reviews`);
      return out as GiteaReview[];
    },
    async deleteReview(owner, repo, prIndex, id) {
      await request("DELETE", `/repos/${owner}/${repo}/pulls/${prIndex}/reviews/${id}`);
    },
    async listIssueComments(owner, repo, prIndex) {
      const out = await request("GET", `/repos/${owner}/${repo}/issues/${prIndex}/comments`);
      return out as GiteaIssueComment[];
    },
    async createIssueComment(owner, repo, prIndex, body) {
      const out = await request("POST", `/repos/${owner}/${repo}/issues/${prIndex}/comments`, { body });
      return out as { id: number };
    },
    async editIssueComment(owner, repo, commentId, body) {
      const out = await request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
      return out as GiteaIssueComment;
    },
    async createCommitStatus(owner, repo, sha, input) {
      const out = await request("POST", `/repos/${owner}/${repo}/statuses/${sha}`, input);
      return out as Record<string, unknown>;
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON body: keep the raw text for error reporting
  }
}
