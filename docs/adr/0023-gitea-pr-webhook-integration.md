# ADR 0023: Gitea PR-review webhook integration on `pir serve`

## Status

Accepted (2026-11-19, delivered in PRs #160–#163).

## Context

PR review is pir's core loop, but every surface so far is client-initiated: a human or a CI step invokes `pir find` and reads stdout. Nothing watched a forge — a pull request could sit for hours next to an idle pir server that had already seen the push, and the review only happened when someone remembered to run the command. The natural next surface is the forge webhook: the forge already knows when a PR opens or receives a push, and pir's verified-findings loop already produces exactly what a PR wants — a walkthrough, findings with file/line anchors, and severities.

Gitea is the first forge because it is self-hostable (no third-party tenancy question for the reviewed code), exposes a plain REST API plus HMAC-signed webhooks, and is what this team runs. The requirements that shaped the design: reviews must appear on the PR itself (a status line, inline findings), not only in a server log; repeat pushes must not spam the thread with unchanged findings; the integration must be off by default and impossible to half-enable; and secrets (bot token, webhook secret) must never live inside a reviewed repository.

## Decision

**Extend `pir serve`, not a companion process (src/server/server.ts, src/gitea/).** The webhook ingress is one more route on the existing server: `POST /v1/webhook/gitea`, authenticated by HMAC-SHA256 over the raw body with a shared secret (`x-gitea-signature`, falling back to the GitHub-compatible `x-hub-signature-256`) rather than the bearer token — Gitea signs, it does not hold a pir token. One deployment unit reuses everything a companion would have to duplicate: the serial execution queue, the job registry (`GET /v1/jobs/<id>`), the repos registry and materialization (`pir repos add`, throwaway worktrees), TLS, and the model credentials already on the serve host.

**Server-side configuration, loud failure (src/gitea/config.ts).** `gitea.json` in the pir config dir (`PIR_CONFIG_DIR`, default `~/.pir`) — or, when the `PIR_GITEA_JSON` env variable is set non-empty, that JSON instead (docker and secret managers inject env without volume-mounting a file; env wins over the file). A missing source keeps the integration off with the route still mounted, answering `503` — a constant, probe-able surface. An invalid source refuses to start: a half-parsed webhook secret is worse than a loud startup failure. Unknown keys are rejected so `skipLabel`/`webhook_secret` typos fail fast. The file holds secrets, so it belongs server-side, never in a repo.

**A pure trigger policy gate (src/gitea/policy.ts).** Watched events: `pull_request` with action opened/reopened — `edited` only once a WIP prefix came OFF the title, because that edit is the "ready for review" signal — and `pull_request_sync` (pushes to an open PR; Gitea's spelling of `synchronized`). Skip rules in a fixed order: draft or WIP title prefix (case-insensitive; Gitea's server-side `WORK_IN_PROGRESS_PREFIXES` may differ, so operators align them), base branch outside the watched `baseBranches` (empty list = every base), a `skipLabels` label, and the bot's own actions (the sender is the bot login learned once per serve process from `GET /user`). Rejections answer `200 {accepted:false, reason:"<code>: …"}` so Gitea does not retry events nobody wanted.

**Status = one evolving comment plus one commit status (src/gitea/render.ts, state.ts).** Each PR gets exactly one status comment, found and edited across runs via a hidden HTML marker (`<!-- pir:status owner/repo#N v1 -->`): started → done (findings table) or failed (sanitized error). Alongside it, a commit status with context `pir/review` on the PR head: pending while the review runs, `success` when clean, the configured `statusOnFindings` (default `success`, advisory; `failure` when the operator wants findings to block) when verified findings exist, `error` when the run failed. Per-PR state (`gitea-state.json`, mode 0600, atomic writes) carries the comment id, last review id, and posted finding fingerprints.

**Publication = one COMMENT review per run, delete-and-repost (src/gitea/orchestrator.ts, client.ts).** Gitea reviews are immutable and there is no GraphQL surface to mutate one, so each run deletes the previous pir review and posts a fresh one — never a growing pile. The review body carries context (base/head, stats, plugins), the `pir summarize` walkthrough, and an overview table of every reportable finding; inline comments pin findings whose anchor falls inside a hunk's new-side span (`new_position`), reviewdog's explicit-filter semantics — anything else is demoted into the table as "not on a changed line", never silently dropped. A finding whose stable fingerprint was already posted on an earlier run of the same PR is counted but not reposted. The review event is always `COMMENT`: findings are advisory.

**Reviewing the PR head from the registered clone (src/app/repos.ts).** The orchestration fetches `refs/pull/N/head` into a stable local ref of the registered clone, materializes a throwaway worktree, and runs `find` + `summarize` there — the same lanes a bundle review uses. A newer push supersedes a queued older run: the webhook route records the latest accepted head per PR, and an in-flight job stands down (outcome `superseded`) once a newer head has taken over, so the serial queue cannot post a stale review on top of a fresh one.

**Rejected alternatives.** A standalone companion service — an extra deploy unit that would need its own TLS termination, model credentials, job surface exposure, and a copy of the repos registry, all to run the same code. A Gitea Actions workflow per repository — Gitea Actions has no auto-cancel for `pull_request` events upstream (gitea#35933), so stale reviews would need exactly the bespoke superseded guard built here anyway, plus the model credentials and trigger policy would be scattered per-repo in workflow files instead of one server-side config. In-repo configuration à la `.pr_agent.toml` — deferred: the webhook secret and bot token are server-side concepts, so secrets would need splitting across two files from day one; a repo-level policy override can layer on top of the server config later if a real need appears.

## Consequences

- One review runs at a time per serve process: webhook reviews queue behind bundle reviews on the serial queue, and a long audit delays PR reviews on the same instance. `GET /health`'s queue stats make the backlog visible.
- The walkthrough adds one extra model session per PR review (`pir summarize` after `find`); a summarize failure only degrades the review to no-walkthrough, it never fails the run.
- Inline comments cannot be posted as thread replies: Gitea's REST API has no reply-to-comment surface today, so every inline comment stands alone under the review.
- Every failure after the status comment is up is reported on the PR (failed status body + `error` commit status) — a webhook must never leave a PR silent — and job outcome settles as `failed` with the sanitized detail.
- An unconfigured serve keeps the route mounted answering `503`; a bad signature answers `401`; accepted triggers answer `202 {accepted:true, jobId}` immediately and run asynchronously.

## Revisit conditions

- Gitea ships a REST (or GraphQL) surface for review threading or review edits: revisit delete-and-repost and the no-replies limitation.
- A second forge integration (GitLab, GitHub) lands: extract the forge-neutral parts (status bookkeeping, fingerprint suppression, anchor mapping) behind a small interface instead of growing `src/gitea/` as a de facto abstraction.
- Per-repository in-repo policy files become a real request: layer them as overrides resolved against the server-side config, keeping secrets server-side.

## References

- PRs #160–#163 (config/policy/state, webhook route + orchestrator, review publication, `docs/for-llm.md` endpoint).
- Setup walkthrough and config reference: the "Gitea integration" section of `README.md` (and `docs/README.zh-CN.md`).
- reviewdog's comment filter semantics (diff-span membership) for inline anchoring.
- gitea#35933 — Actions auto-cancel gap, the reason the Actions alternative was rejected.
- `docs/adr/0004-change-mode-review-pipeline.md` for the review lanes the orchestrator reuses; `docs/adr/0016` Part IV for the job model the webhook jobs share.
