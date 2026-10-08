import { test } from "node:test";
import assert from "node:assert/strict";
// Type-stripped import: live-fold.ts is the pure (React-free) half of the
// live pipeline, kept out of the .tsx component file precisely so this suite
// can drive the flush/fold contract end to end.
import { createLiveFold, mergeEvents } from "../../web/src/live-fold.ts";

// The pipeline under test, mirroring RunDetailPage: SSE events buffer up and
// every 80ms flush runs mergeEvents(previous, pending), then SessionTimeline's
// useLiveSessions folds the WHOLE merged array through a seq-cursor fold.
// mergeEvents folds same-session/same-type deltas into the previous flush's
// last element — cumulative text, newest seq — so a naive appending fold
// re-adds the whole tail on every flush (dogfood F-35).

let seq = 0;
const nextSeq = () => ++seq;

const start = (sessionId) => ({
  kind: "session-start", sessionId, sessionKind: "reviewer", role: "code reviewer",
  model: null, prompt: "review the diff", ts: nextSeq(), seq: nextSeq(),
});
const delta = (sessionId, text, deltaType = "text") => ({
  kind: "session-delta", sessionId, deltaType, text, ts: nextSeq(), seq: nextSeq(),
});
const block = (sessionId, type, text) => ({
  kind: "session-block", sessionId, ts: nextSeq(), seq: nextSeq(),
  block: type === "toolCall"
    ? { type, id: "call-1", name: "read_file", arguments: { path: "x.ts" } }
    : { type, text },
});

function tailText(views, sessionId) {
  const session = views.find((candidate) => candidate.sessionId === sessionId);
  const tail = session?.items[session.items.length - 1];
  return tail?.type === "text" || tail?.type === "thinking" ? tail.text : undefined;
}

test("live fold: deltas streamed across many flushes land exactly once (dogfood F-35)", () => {
  const fold = createLiveFold();
  let events = mergeEvents([], [start("s1")]);
  fold.append(events);

  // 50 flushes of one delta each — the shape continuous streaming produces.
  const chunks = Array.from({ length: 50 }, (_, i) => `[chunk ${i} ] `);
  for (const chunk of chunks) {
    events = mergeEvents(events, [delta("s1", chunk)]);
    fold.append(events);
  }
  const expected = chunks.join("");
  assert.equal(tailText(fold.append(events), "s1"), expected);

  // ...and the same total when several deltas share one flush (SSE replay
  // batches after a pause), or flushes carry multiple deltas.
  seq = 0;
  const fold2 = createLiveFold();
  let events2 = mergeEvents([], [start("s2")]);
  fold2.append(events2);
  for (let i = 0; i < chunks.length; i += 5) {
    events2 = mergeEvents(events2, chunks.slice(i, i + 5).map((chunk) => delta("s2", chunk)));
    fold2.append(events2);
  }
  assert.equal(tailText(fold2.append(events2), "s2"), expected);
});

test("live fold: a settled tail after interleaved blocks has the full text once", () => {
  const fold = createLiveFold();
  let events = mergeEvents([], [start("s1")]);
  fold.append(events);

  // Stream text, then a toolCall breaks the delta run, then more text.
  const firstRun = "first streamed run ";
  for (const word of firstRun.split(" ")) {
    if (!word) continue;
    events = mergeEvents(events, [delta("s1", `${word} `)]);
    fold.append(events);
  }
  events = mergeEvents(events, [block("s1", "toolCall")]);
  fold.append(events);
  const secondRun = "second run";
  for (const letter of secondRun) {
    events = mergeEvents(events, [delta("s1", letter)]);
    fold.append(events);
  }

  const session = fold.append(events).find((candidate) => candidate.sessionId === "s1");
  const texts = session.items.filter((item) => item.type === "text").map((item) => item.text);
  assert.equal(texts[0], firstRun, "the first run settles with its own text, once");
  assert.equal(tailText(fold.append(events), "s1"), secondRun);
  assert.ok(!texts.join("").includes(firstRun + firstRun), "no duplicated run text");
});

test("live fold: an authoritative session-block supersedes the streamed buffer", () => {
  const fold = createLiveFold();
  let events = mergeEvents([], [start("s1"), delta("s1", "partial stre")]);
  fold.append(events);
  events = mergeEvents(events, [delta("s1", "amed")]);
  fold.append(events);
  // The authoritative block replaces the streamed text entirely.
  events = mergeEvents(events, [block("s1", "text", "partial streamed, finalized")]);
  const session = fold.append(events).find((candidate) => candidate.sessionId === "s1");
  const texts = session.items.filter((item) => item.type === "text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "partial streamed, finalized");
  assert.equal(texts[0].streaming, false);
});
