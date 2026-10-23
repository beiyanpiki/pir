# ADR 0022: Local detached execution for `find` and `audit`

## Status

**Accepted (2026-10-23).** Explicit local `--detach` for `find` and `audit`: the run is re-executed as a detached background process with an owner-only log and a receipt, and the submitting invocation returns as soon as that child is accepted. It adds no resume, no daemon, no job registry, no new durable run state and no coverage-contract change; remote `--detach` semantics, the `--json` envelope contract and exit codes 0/1/2/3 are unchanged.

## Context

ADR 0018 recorded the one durability failure on record, and ADR 0018 is also where this item comes from. A six-and-a-half-hour local audit (2026-09-30) persisted 152 verified findings and then died when its SSH session disconnected; the findings survived as project rows, the remaining coverage did not, and no audit ran on that project afterwards. ADR 0018's demand discovery says the likeliest cause is the process dying with its terminal, its Decision 1 names the cheap remedy — "keeping the process alive across a disconnect (or offering local detached execution, which today is remote-only)" — and its Consequences call local durability the next investment and a separate item. This ADR is that separate item.

The current behaviour is a deliberate double rejection. `#53` made `--detach` a remote submission flag and asked the CLI to define or reject local-mode detach clearly; the executor rejects the flag in two places, `src/cli/executor.ts:1197-1201` (find) and `:1377-1382` (audit), so no lane can silently ignore it. That rejection is honest, but it leaves the recorded failure mode uncovered: a local run is still bound to the terminal that started it.

The existing remote machinery cannot be reused locally. Detached remote work is a server-side job in the serve process's in-memory registry (`src/cli/jobs.ts`, `GET /v1/jobs`); `pir jobs` is a remote-only lane by contract, the registry is lost on restart, and nothing local implements that lifecycle. A local receipt already exists for accepted remote submissions (`#52`, `src/cli/receipts.ts`) — a durable record of origin, job id, project identity, pinned base/head and the credential-free argv — and that shape is reusable without any server.

## Decision

1. **Explicit `--detach` only, on `find` and `audit` only.** Local detach is opt-in per invocation. Ordinary local runs stay attached, keep their stdout and exit code, and are byte-identical to today; there is no auto-detach.
2. **Client-side handling after the remote-forward branch.** In `src/cli/cli.ts` a local `--detach` is handled after remote forwarding and before `executePirCommand`, and only when the resolved transport is local. Remote `--detach` keeps going through `src/cli/remote.ts` unchanged, and the executor-level rejections stay in place: a server receiving an unstripped `--detach` from an old client must still fail rather than silently ignore it.
3. **The child is a re-exec of this build.** The parent spawns `process.execPath` with `path.resolve(process.argv[1])` and the caller's argv with exactly one `--detach` token removed, at the parent's current working directory. No new entry point, no compiled variant, no shell: the detached run is the same CLI the user invoked.
4. **Detached and unref'd.** `spawn(..., { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] })`, then `unref()` and the parent closes its own descriptor. The child is in its own session/process group, its stdin is `/dev/null`, and its stdout/stderr go to the log file instead of the terminal's pipes, so closing the terminal cannot take it down with a SIGHUP on the wrapper.
5. **The child is told what it is.** The child environment carries `PIR_LOCAL_JOB_ID=<jobId>` and `PIR_NO_WIZARD=1`. The job id is what lets the child settle its own receipt; the wizard is disabled because a detached run has no terminal to answer it. The child never re-detaches: when `PIR_LOCAL_JOB_ID` is set, the detach branch is skipped.
6. **The log is the child's output, owner-only.** The log is `<config dir>/logs/<jobId>.log` (`~/.pir/logs/<jobId>.log` by default, following `PIR_CONFIG_DIR` like receipts), created 0600 with its directory 0700. It receives everything the child would have printed; the parent writes nothing to it after the spawn.
7. **The receipt is extended, not replaced.** The existing schemaVersion 1 receipt gains optional `mode: "local"`, `logPath` and `exitCode`; `mode` absent or `"async"` reads as a remote submission, so every receipt written before this ADR still parses and lists. The parent writes the local receipt before spawning (`origin: "local"`, `runId: null`, HEAD or an empty string, the credential-free sanitized argv), and the child settles it from its `exit` hook (`settledAt`, `exitCode`). A missing receipt makes settlement a no-op.
8. **Exit 0 means accepted, not reviewed.** The submission envelope (`find.detach`/`audit.detach` under `--json`, a human block otherwise) carries the job id, the mode, the log path, the receipt path and the follow-up commands. Exit 0 attests that the child started; the review's own outcome lives in the log, the receipt's `exitCode` and the project database.
9. **Lanes that cannot detach refuse loudly.** `--detach` with `find --preview`, with `audit coverage`, with `audit --dry-run`, and on any command other than `find`/`audit` is a usage error (exit 2) — those invocations either produce no run or are not review commands, so there is nothing to detach.
10. **The receipt stays credential-free.** The argv recorded in the receipt goes through the same sanitizer the remote receipt uses (`--token`/`--viewer-token` dropped, inline user background redacted). The log is the child's ordinary output and follows the same rules as any other local run.
11. **No auto-detach, no daemon, no local jobs lane.** Nothing starts a background process that the user did not explicitly ask for, nothing keeps a supervisor alive between invocations, and `pir jobs` stays remote-only.

## Rejected alternatives

- **Auto-detach of ordinary local runs.** Detaching by default would change the meaning of every existing local invocation and CI job — stdout would stop carrying the result, exit codes would stop gating anything, and an interactive run would silently outlive its terminal. An explicit flag is the only version whose contract a caller can rely on.
- **A local daemon (a `pir serve`-like local supervisor).** It would need its own process lifecycle, socket or port, authentication, upgrade story and cleanup, plus a way to keep running across logins. That is orders of magnitude beyond the one recorded incident, and ADR 0018 already refuses the adjacent resume machine for the same reason.
- **A local `pir jobs` lane.** The job registry is in-memory server state, and `jobs list|status|wait|fetch` is documented as remote-only. Reusing the vocabulary locally would promise a lifecycle (status, wait, fetch, retention, cancel) that this design does not implement and cannot honestly fake.
- **Run-id linkage in the receipt.** The child's run id only exists after its run row is created, and the parent exits before that. The child could update its own receipt once the run exists, but no consumer asks for it today, and a stale or invented id is worse than an honest `null` and `pir findings list`. Recorded as a revisit condition rather than built speculatively.

## Consequences

- A long local `find` or `audit` can now outlive its terminal. Exit 0 from the submitting command means the run was accepted, never that it was reviewed or passed; the receipt carries the child's final `exitCode` once it settles, and the log is at `~/.pir/logs/<jobId>.log`. Follow-up is local and needs no server: `tail -f` the log, `pir receipts show <id8>` for the settled code, `pir audit coverage --latest` for an audit's run status, `pir findings list` for what it wrote.
- The limitations are real and stated rather than papered over. Two concurrent local detaches are told apart only by their receipts and logs — there is no "the detached one" selector. `pir audit coverage --latest` names the latest run, which is not necessarily the detached one, so an operator reads the receipt and the log when concurrency matters. The receipt carries no run id. `--fail-on` cannot gate the parent, because the review finishes after the parent is gone; an automation that needs a gate must check the receipt's exit code or the findings afterwards.
- There is no watchdog. A detached run whose child is killed (`SIGKILL`, OOM, reboot) leaves a receipt that stays unsettled — no `settledAt`, no `exitCode` — and a log that stopped growing. That is the documented way to tell a killed detach from a running one; the price of the distinction is that nothing detects it for the operator.
- No resume is added. A killed detached run is not restarted, continued or salvaged; ADR 0018's no-go stands and this ADR does not contradict it — it prevents the recorded loss at the process layer instead of promising to continue dead compute.
- Remote semantics are untouched. The remote detach envelope, async submission, job polling, receipts and the executor's server-lane rejections behave exactly as before; `--detach` in remote mode never reaches the local lane.
- Coverage is unchanged: a detached audit writes the same run, rows and ledger as an attached one, and ADR 0013's single-ledger contract is not touched.

## Revisit conditions

- **Run-id linkage**, if a consumer (web UI, `pir runs status`, an automation) needs to address a detached run by id rather than by receipt/log.
- **Per-detach run selection**, if running two local detaches concurrently becomes routine, so `--latest` stops being ambiguous for operators.
- **Log rotation or size caps**, if detached logs grow large enough that an unbounded `~/.pir/logs` becomes a problem; the retention story would then need a documented policy.
- **A real local supervisor** (daemon, list/kill), if local detach becomes the standard way to run long audits and lifecycle questions — "what is running and how do I stop it" — arrive with it.

## References

- Decision record and the recorded incident: [ADR 0018](0018-audit-resume-identity-protocol.md) (audit resume: no-go; demand discovery, Decision 1 and Consequences name local durability as the separate cheap remedy).
- Related contracts: [ADR 0013](0013-change-coverage-manifest-decision.md) (one coverage ledger, unchanged), [ADR 0016](0016-user-background-for-find.md) (the argv sanitizer the receipt reuses).
- Issues: [#53](https://github.com/beiyanpiki/pir/issues/53) (remote detach, and "define or reject local-mode detach clearly"), [#52](https://github.com/beiyanpiki/pir/issues/52) (submission receipts), [#55](https://github.com/beiyanpiki/pir/issues/55) (poll liveness), [#56](https://github.com/beiyanpiki/pir/issues/56) (audit scope preview / coverage readout).
- Implementation: [`src/cli/detach.ts`](../../src/cli/detach.ts) (validation, argv rewrite, log, spawn, envelope), [`src/cli/receipts.ts`](../../src/cli/receipts.ts) (local receipt, settlement, recovery commands), [`src/cli/cli.ts`](../../src/cli/cli.ts) (the local-detach branch and the child's exit hook), [`src/cli/executor.ts`](../../src/cli/executor.ts) (help strings; the server-lane rejections stay).
- Tests: [`tests/unit/cli-detach.test.js`](../../tests/unit/cli-detach.test.js), [`tests/integration/cli-detach-local.test.js`](../../tests/integration/cli-detach-local.test.js).
- Docs: [`README.md`](../../README.md), [`docs/for-llm.md`](../for-llm.md), [`docs/design.md`](../design.md), [`docs/review-loop.md`](../review-loop.md), [`docs/README.zh-CN.md`](../README.zh-CN.md).
