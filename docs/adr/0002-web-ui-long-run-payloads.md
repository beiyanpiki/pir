# ADR 0002: Web UI payload and rendering strategy for long runs

## Status

Accepted (2026-10-07, web UI performance for 100+ finding runs).

## Context

The read-only web UI initially fetched and rendered everything at once:

- `GET /api/runs/:projectId/:runId` returned every finding with its full
  claim, evidence excerpts, memory matches and verifier rationale, plus the
  whole manifest — a run with 100+ findings answers in megabytes.
- For a *running* run the same response embedded `LiveRunState.events`, the
  registry's entire replay buffer (bounded at 32 MB), and the SSE
  `/api/events` stream then replayed the identical events again — a mid-run
  join downloaded the buffer twice.
- Nothing was compressed or cache-negotiated: transcripts are immutable
  files written once at session end, yet they were served `no-store`, so
  every revisit re-downloaded them whole (the largest on record is ~527 KB).
- The timeline mounted every session section permanently once fetched, and
  the live fold re-derived the whole event history on every 80 ms flush,
  reallocating every session and re-rendering all of them.

## Decision

**Transport (src/server/web.ts, web-store.ts):**

- All API JSON bodies and textual static assets are gzip-compressed when the
  client sends `accept-encoding: gzip` and the body exceeds 1 KB. SSE is
  never compressed (flush latency matters more than bytes). Compression is
  synchronous, matching the handlers' existing sync posture; moving it (and
  `JSON.stringify`) off the hot loop is a future refinement.
- Transcripts (and `run.json`) answer with a stat-based ETag and
  `cache-control: no-cache`: stored, always revalidated, and a revisit costs
  a bodyless 304.
- The REST run detail ships finding **summaries** only (`{ items, total }`,
  ~300 B per row) plus live **metadata**; the replay buffer rides the SSE
  channel exclusively.
- Two new read-only endpoints carry the deferred weight:
  `GET /api/runs/:p/:r/findings?limit=&offset=` (paged summaries) and
  `GET /api/runs/:p/:r/findings/:findingId` (one full finding).
  `readTranscript` now also validates `runId`, closing a traversal gap the
  detail route never had.

**Rendering (web/src):**

- Findings rows render from summaries and fetch their detail on first
  expand (client-cached).
- Timeline sections use a *mount window*: a two-way IntersectionObserver
  (±1600 px) mounts content near the viewport and unmounts it far away,
  pinning the last measured height on the placeholder so the scrollbar does
  not jump; fetched transcripts live in a small client-side LRU so a remount
  is instant.
- `content-visibility: auto` (+ `contain-intrinsic-size`) on session
  sections, transcript rows and expanded finding details skips layout and
  paint for offscreen content.
- The live fold is incremental: per-session state with a seq cursor folds
  only new events, and only touched sessions get fresh object identities, so
  `React.memo` skips the rest. The flush merge is single-pass instead of
  per-event array copies.

**Rejected:** a virtual-list library (react-virtual/virtua). Timeline blocks
vary hugely in height and the SessionRail needs anchor jumps into them;
windowed scrolling with estimated heights is fragile there, while
content-visibility plus height-pinned mount/unmount achieves bounded DOM
without new dependencies. A server-side "summary view" of transcripts was
also considered and deferred — gzip + ETag + lazy mounting made the full
JSON cheap enough that the extra wire format did not pay for itself yet.

## Consequences

- The run-detail response shape changed (`findings` is now
  `{items, total}`; `live` has no `events`). Server and SPA ship together
  from this repository, so no external consumer breaks; the SSE wire format
  is untouched.
- First paint of a 100+ finding run is a few KB; opening a row or scrolling
  the timeline costs one small request each, and revisits are 304s.
