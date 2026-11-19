import { test } from "node:test";
import assert from "node:assert/strict";

const { GiteaApiError, createGiteaClient } = await import("../../dist/gitea/client.js");

const BASE = "https://gitea.example.com";
const API = `${BASE}/api/v1`;
const TOKEN = "bot-token-0123456789";

/** Scripted fetch: pops one planned response per call and records every request. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted fetch ran out of responses");
    if (next instanceof Error) throw next;
    const { status = 200, body } = next;
    // 204 forbids a body; anything else JSON-encodes (undefined → empty body).
    const payload = body === undefined || status === 204 ? null : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

function client(fetchImpl) {
  return createGiteaClient({ baseUrl: `${BASE}/`, token: TOKEN, fetchImpl });
}

test("gitea client: createReview posts the comment array verbatim with token auth", async () => {
  const { impl, calls } = scriptedFetch([{ status: 201, body: { id: 1001 } }]);
  const out = await client(impl).createReview("beiyan", "pir-demo", 42, {
    body: "<!-- pir:review v1 -->\n1 finding",
    comments: [
      { body: "F-1: off-by-one", path: "src/login.ts", new_position: 42 },
      { body: "F-2: missing await", path: "src/retry.ts", new_position: 7 },
    ],
  });
  assert.deepEqual(out, { id: 1001 });
  assert.equal(calls.length, 1);
  const call = calls[0];
  // Trailing slash in baseUrl must not become a double slash in the path.
  assert.equal(call.url, `${API}/repos/beiyan/pir-demo/pulls/42/reviews`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, `token ${TOKEN}`);
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.body), {
    body: "<!-- pir:review v1 -->\n1 finding",
    event: "COMMENT",
    comments: [
      { body: "F-1: off-by-one", path: "src/login.ts", new_position: 42 },
      { body: "F-2: missing await", path: "src/retry.ts", new_position: 7 },
    ],
  });
});

test("gitea client: every method hits its Gitea API path with the right verb", async (t) => {
  const plan = [
    { status: 200, body: [{ id: 7, user: { login: "pir-bot" }, body: "stale" }] }, // listReviews
    { status: 204 }, // deleteReview
    { status: 200, body: [] }, // listIssueComments
    { status: 201, body: { id: 3003 } }, // createIssueComment
    { status: 200, body: { id: 3003, body: "edited" } }, // editIssueComment
    { status: 201, body: { id: 9, status: "success" } }, // createCommitStatus
  ];
  const { impl, calls } = scriptedFetch(plan);
  const api = client(impl);
  t.after(() => assert.equal(plan.length, 0, "every scripted response was consumed"));

  assert.deepEqual(await api.listReviews("o", "r", 5), [{ id: 7, user: { login: "pir-bot" }, body: "stale" }]);
  assert.equal(calls[0].url, `${API}/repos/o/r/pulls/5/reviews`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);

  await api.deleteReview("o", "r", 5, 7);
  assert.equal(calls[1].url, `${API}/repos/o/r/pulls/5/reviews/7`);
  assert.equal(calls[1].method, "DELETE");

  assert.deepEqual(await api.listIssueComments("o", "r", 5), []);
  assert.equal(calls[2].url, `${API}/repos/o/r/issues/5/comments`);

  assert.deepEqual(await api.createIssueComment("o", "r", 5, "status line"), { id: 3003 });
  assert.equal(calls[3].url, `${API}/repos/o/r/issues/5/comments`);
  assert.equal(calls[3].method, "POST");
  assert.deepEqual(JSON.parse(calls[3].body), { body: "status line" });

  assert.deepEqual(await api.editIssueComment("o", "r", 3003, "status line v2"), { id: 3003, body: "edited" });
  assert.equal(calls[4].url, `${API}/repos/o/r/issues/comments/3003`);
  assert.equal(calls[4].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[4].body), { body: "status line v2" });

  assert.deepEqual(await api.createCommitStatus("o", "r", "abc123", {
    state: "failure",
    context: "pir/review",
    description: "2 verified findings",
    target_url: "https://pir.svc/run/xyz",
  }), { id: 9, status: "success" });
  assert.equal(calls[5].url, `${API}/repos/o/r/statuses/abc123`);
  assert.equal(calls[5].method, "POST");
  assert.deepEqual(JSON.parse(calls[5].body), {
    state: "failure",
    context: "pir/review",
    description: "2 verified findings",
    target_url: "https://pir.svc/run/xyz",
  });
});

test("gitea client: non-2xx throws GiteaApiError with the parsed Gitea message", async () => {
  const { impl } = scriptedFetch([
    { status: 404, body: { message: "Not Found", url: "https://gitea.example.com/api/v1/swagger" } },
    { status: 422, body: { message: "pull request has been merged" } },
    { status: 500 }, // no body at all: message degrades to "Gitea API 500"
    { status: 401, body: { message: "token is invalid" } },
  ]);
  const api = client(impl);

  for (const [status, message] of [
    [404, "Not Found"],
    [422, "pull request has been merged"],
    [500, "Gitea API 500"],
    [401, "token is invalid"],
  ]) {
    await assert.rejects(
      () => api.createReview("o", "r", 42, { body: "x", comments: [] }),
      (err) => {
        assert.ok(err instanceof GiteaApiError);
        assert.equal(err.status, status);
        assert.equal(err.message, message);
        assert.equal(err.name, "GiteaApiError");
        return true;
      },
      `expected ${status} -> "${message}"`,
    );
  }
});

test("gitea client: transport failures propagate as-is, not GiteaApiError", async () => {
  const { impl } = scriptedFetch([new Error("connect ECONNREFUSED 127.0.0.1:3000")]);
  await assert.rejects(
    () => client(impl).listReviews("o", "r", 1),
    (err) => !(err instanceof GiteaApiError) && /ECONNREFUSED/.test(err.message),
  );
});

test("gitea client: non-JSON error body degrades to its text, HTML proxies included", async () => {
  // Hand-build this one: the scripted helper always JSON-encodes bodies.
  const impl = async () =>
    new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  await assert.rejects(
    () => client(impl).listReviews("o", "r", 1),
    (err) => err instanceof GiteaApiError && err.status === 502 && err.message.includes("502 Bad Gateway"),
  );
});

test("gitea client: getCurrentUser returns the token account's login from GET /user", async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: { id: 3, login: "pirbot", full_name: "pir bot" } }]);
  assert.deepEqual(await client(impl).getCurrentUser(), { login: "pirbot" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/user`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

test("gitea client: getCurrentUser rejects a 200 body without a login", async () => {
  const { impl } = scriptedFetch([{ status: 200, body: { id: 3 } }]);
  await assert.rejects(
    () => client(impl).getCurrentUser(),
    (err) => err instanceof GiteaApiError && /no login/.test(err.message),
  );
});

test("gitea client: an api/v1-suffixed baseUrl normalizes to the same URLs", async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: { id: 1, login: "pirbot" } }]);
  await createGiteaClient({ baseUrl: `${BASE}/api/v1/`, token: TOKEN, fetchImpl: impl }).getCurrentUser();
  assert.equal(calls[0].url, `${API}/user`);
});
