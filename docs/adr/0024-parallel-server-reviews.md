# ADR 0024: Bounded parallel review admission on `pir serve`

## Status

Accepted (2026-11-25).

## Context

Before this decision, `pir serve` put every mutating executor task on one global promise chain: bundle materialization, review execution, worktree cleanup, registered-repository work, project-memory operations, and Gitea PR reviews all waited for the one task ahead of them. That shape was simple and correct, but it made unrelated work share one latency domain. A long audit blocked a Gitea PR on another repository; the first CodeGraph seed build for one project blocked every queued review; and one slow provider response serialized the whole instance. The Gitea integration made that head-of-line blocking a user-visible product problem, because a PR status could sit at `pending` behind work that had nothing to do with the PR.

The desired change was bounded parallelism inside the existing serve process, not a new execution architecture. The default had to remain exactly one review at a time for existing deployments. Running reviews must still get isolated workspaces at pinned revisions, must still share one project memory database keyed by remote URL plus root commit, and must not race Gitea's per-PR state or publication. Read-only commands already ran outside the mutating chain under their own cap; that lane had to keep working unchanged.

## Decision

**A process-local admission scheduler with two caps.** `src/server/executor-scheduler.ts` admits tasks up to `--review-concurrency N` (`PIR_REVIEW_CONCURRENCY`) global slots, with at most `--project-review-concurrency N` (`PIR_PROJECT_REVIEW_CONCURRENCY`) admitted `review` tasks per project. Both default to `1`. Precedence is the flag, then the corresponding environment variable, then the default; an empty environment variable counts as unset. Values are positive decimal safe integers, and an invalid value refuses startup. `pir serve --review-concurrency 4 --project-review-concurrency 2` is the documented example, with `2/2` recommended for a first rollout. The scheduler is process-local and in-memory, like the job registry it serves.

**A slot is the whole review lifetime.** A global slot is reserved before user code starts and covers repository preparation/materialization, command execution, and worktree cleanup. Admitted maintenance work occupies a slot as well; waiting tasks do not. Raising only the global cap permits different projects to overlap but still admits one review per project; same-project parallelism requires raising both caps.

**Scopes encode conflict, not priority.** A `review` task is charged to its project and may overlap other-project reviews within the global cap. A Gitea PR review additionally carries a `resourceKey`, so the entire orchestrate-and-publish lifecycle for that PR is mutually exclusive. A `project-exclusive` task blocks any same-project review or maintenance while it runs: this is the lane for `memory bootstrap`, `memory refresh`, `feedback`, `remember`, `verify-fix`, and `memory sync`, which mutate or depend on shared project memory. A `global-exclusive` task waits for the pool to drain and blocks new admissions: this is the conservative lane for `repos add`/`remove`, direct-workspace commands, and targets whose project identity cannot be resolved. A blocked project does not block unrelated projects, and a conflicting task never overtakes an earlier barrier.

**Gitea keeps one owner per PR.** Different PRs may run in parallel, but one PR's status comment, commit status, review deletion/reposting, and `gitea-state.json` entry are all serialized by the PR resource key. Repeated webhooks for the same head keep the existing re-review and fingerprint-dedupe behavior; this decision adds no new cancellation or same-head deduplication. A run whose head is replaced while its model sessions execute rechecks supersession before publishing and stands down with `outcome: "superseded"`, so an older head cannot overwrite a newer review.

**Workspace and repository isolation stay explicit.** Every bundle and registered materialization uses a fresh UUID-named linked worktree at an immutable pinned SHA, so concurrent runs of one project never share a checkout. The repository layer serializes shared mutations (registry, refs, seed index) with cross-process locks and refuses to purge a project or rebuild a corrupt bundle cache while an active linked worktree still depends on it. CodeGraph keeps a private index in each worktree and a shared per-project seed under the existing seed lock; repository preparation can still wait for its resource lock.

**Project identity and memory are unchanged.** The project key remains the normalized remote URL plus root commit. Parallel reviews do not split the database per PR or branch: run rows, findings, audit coverage, and transcript directories are isolated by run id, while the project memory database is shared. A bundle review and a Gitea PR of the same project therefore share memory but never a run or transcript record.

**Boundary behavior is additive and conservative.** `/v1/review` rejects a bundle request carrying `--repo` with HTTP 400 and directs the caller to `/v1/exec`, so a bundle cannot re-target a registered clone. A registered `/v1/exec` target is resolved and its project id frozen before admission; an unresolved target stays globally exclusive rather than guessing. `GET /health` keeps its existing wire shape: `executor.pending` counts running plus waiting admissions and `oldestPendingMs` is the oldest admission age. The proven read-only fast lane keeps its separate 16-request cap and is not counted in this pool.

**Rejected alternative: a durable worker queue.** A queue backed by Redis, SQLite, or an external process would add deployment units, leases, retry/idempotency rules, and restart-resume semantics that this change does not promise. The existing serve model is already process-local and in-memory for jobs; a durable queue would make a restart look recoverable while runs, workspaces, and model sessions are not. Admission shape was the problem, not delivery durability, so the minimal change is an in-process scheduler over the existing job and run records.

**Why maintenance is exclusive.** Project memory operations mutate per-project state that a same-project review reads while its sessions run. A maintenance barrier prevents bootstrap, refresh, feedback, remember, verify-fix, or sync from racing a review of the same project and keeps the existing "one writer, WAL readers" relationship legible; Gitea publication uses its own per-PR resource key instead of this barrier. `repos add`/`remove` touch the registry and project directories, and direct-workspace or unknown targets have no reliable project key, so those stay globally exclusive rather than inventing a narrower identity.

**Explicit non-goals.** This decision does not add multi-process coordination or sharing of state/repository/config volumes between serve instances; does not add a persistent queue, restart resume, or exactly-once delivery; does not add a global model-session or provider request limiter; and does not add automatic PR cancellation. It changes admission, not review semantics.

## Consequences

- Existing deployments keep the serial behavior because both caps default to `1`; the flags and environment variables are opt-in.
- Different projects can overlap with only the global cap raised, but same-project parallelism requires both caps. This is a common source of confusion and is called out in the user and operator docs.
- Throughput is now a deployment choice with a cost: `--verify-concurrency` and `--angles` can multiply the model requests of each admitted run, so the caps are not a global model budget. Provider rate limits and spend can rise; operators must size them deliberately.
- `GET /health` remains wire-compatible: `pending` includes running and waiting tasks, `oldestPendingMs` measures the oldest admission, and no field was added.
- A restart still loses queued and running work and interrupts model sessions; durable run rows, findings, audit checkpoints, and transcripts remain. Separate serve processes do not coordinate, so operators must not point multiple instances at the same state/repository/config volumes.
- A long audit or first index build no longer has to block unrelated projects once concurrency is raised, but a `global-exclusive` task still pauses the whole pool, and one project still has a maintenance barrier.
- Gitea PRs gain cross-PR concurrency without weakening per-PR ordering: one current review, no stale publication, and unchanged same-head dedupe.

## Revisit conditions

- Operators need queued work to survive a restart, or need exactly-once/resume semantics: revisit a durable queue rather than stretching this scheduler.
- Multiple serve instances must share state/repository/config volumes, or a load balancer fronts several instances: define cross-process admission and locking before promising it.
- Provider spend or rate limiting becomes the bottleneck: add an explicit global model/request limiter with its own configuration and observability instead of overloading the review caps.
- PR auto-cancel becomes a product requirement: add a deliberate cancellation protocol; this ADR only guarantees pre-publish recheck and stand-down.
- Measured waiting or cost data shows the conservative `global-exclusive` lane for maintenance is too coarse, or same-project parallelism needs fairness beyond a count cap.
- Repository maintenance grows more concurrent: revisit the linked-worktree guard and seed lock as first-class scheduler barriers rather than filesystem locks.

## References

- Service concurrency and Gitea behavior: the "Review concurrency" section of `README.md`, `docs/design.md` ("Queueing, reads, and jobs"), and `docs/gitea-integration.md`.
- Implementation: `src/server/executor-scheduler.ts`, `src/server/server.ts`, `src/gitea/orchestrator.ts`, `src/gitea/state.ts`, and `src/app/repos.ts`.
- Tests: `tests/integration/server-concurrency.test.js` and `tests/integration/gitea-webhook.test.js`.
- Related decisions: [ADR 0001](0001-shared-review-executor.md) for the shared review executor, [ADR 0016](0016-invocation-inputs-outputs-and-long-runs.md) for jobs and long-running execution, and [ADR 0023](0023-gitea-pr-webhook-integration.md) for the Gitea integration this admission model serves.
