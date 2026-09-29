# Go review directions

These directions only sharpen where to look; every finding still needs the same causal evidence as any other claim. Style, naming and formatting are out of scope (that is gofmt/lint territory, not defects). First read the `go` directive in go.mod at head: language semantics are version-gated, so check the version before claiming version-dependent bugs.

## Error handling

- A discarded error (`_ =` or an unchecked second return) is a finding only when the ignored value can plausibly be non-nil on a path this change touched and the consequence is nameable.
- `%v` wrapping where callers rely on errors.Is/As breaks the unwrap chain: check the wrap site and every matching/unwrapping caller reachable from this change.
- Comparing errors with `==` or a direct type assertion defeats wrapping; errors.Is/errors.As is the contract callers assume.
- Handling the same error twice (log plus return, or wrap after logging) duplicates or loses context — trace which layer owns reporting on the changed path.
- Writes: `defer f.Close()` without capturing the error silently drops failed flushes on files/connections this change added. Read-side Close errors are usually tolerable.
- errors.Join matches on ANY joined error; verify that matches what matching callers expect.

## Concurrency

- Every goroutine this change starts needs a termination story you can point to: channel close by an owner, context cancellation, bounded iteration, or process exit. A goroutine blocked forever on send/recv leaks — the GC never collects a running goroutine.
- Closing authority: only the sender/owner closes. Sending on a closed channel or closing twice panics; a diff that reassigns or shares a channel is a prime suspect.
- A nil channel in select disables that case: distinguish intentional disabling from a never-initialized channel.
- Notification is by close (`close(done)`), data transfer is by send; mixing them loses wakeups or deadlocks.
- sync.WaitGroup: Add before spawning the goroutine that calls Done, and Done on every return path (pair with defer); Add-inside-loop vs Add-once mismatches undercount.
- Maps: any concurrent write with another access is an unrecoverable runtime crash. Look for maps shared across goroutines this change introduces, including via closures and method values.
- append on a shared backing array from two goroutines corrupts data; sync types (Mutex, WaitGroup, Cond…) copied by value are broken — check struct copies, value receivers, and by-value parameters.
- time.After inside a loop allocates a live timer per iteration that piles up until it fires.
- Context: not the first parameter, stored in a struct, or a derived cancel/timeout dropped before the blocking call — the cancellation chain this change needs must actually reach the I/O operation, not just be carried alongside.
- select among multiple ready cases picks randomly: code assuming a fixed order is defective.

## Data-structure semantics

- Returning a typed nil pointer where callers assign the result to an interface yields a non-nil interface holding nil — compare the declared return type with the concrete nil being returned.
- append may share or copy the backing array: writes through one slice surface in the other (aliasing), or growth detaches a slice the code expected to stay shared.
- A sub-slice pins the whole backing array (memory retention) and aliases it; long-lived storage needs a copy.
- nil and empty slices/maps differ for JSON encoding (null vs []) and can differ for reflection-based checks; when the change switches which one is produced, check consumers.
- range copies the element: taking &elem or storing &elem across iterations only pre-dates Go 1.22 semantics — gate on go.mod.
- Narrowing conversions (int→int32/uint16…), len()/cap() math on attacker-influenced sizes, and Duration-vs-raw-number unit mixes (ms vs s) — find the concrete input that overflows or truncates.

## Resource management

- defer inside a loop holds the resource until function return, not per iteration: loops this change adds with defer Close/Query inside are leak suspects.
- Early error returns that skip cleanup: cleanup must be deferred or on every path — HTTP response bodies, sql.Rows, os.File, tickers, tickers' Stop.
- http.Error (or writing a response) followed by more handler code instead of return corrupts responses or double-writes.

## Backend boundaries

- SQL built by fmt.Sprintf/concatenation with anything request-influenced is injection; bound parameters are the contract. Check placeholder arity and ordering against args.
- Transactions: work outside the tx after reading inside it, missing Rollback on error paths (defer Rollback is safe after Commit), or pool exhaustion from long-held connections against SetMaxOpenConns.
- N+1: queries or RPC calls inside a loop over rows/items this change introduced; a JOIN, IN batch, or preload on the same path is counter-evidence.
- API compatibility: this change alters an exported identifier's signature or behavior, renames/removes JSON fields or changes tags (name, omitempty), renumbers error codes, or changes gRPC/proto field semantics — check in-repo callers AND serialized/persisted data before calling it safe.
- A zero-value http.Client{} has no timeout: new outbound calls without a Timeout (or a per-request context deadline) hang forever against a stuck server.

## Tests changed by this diff

- Tests this change writes can themselves be the defect: t.Parallel over shared state (including subtests closing over the same vars), missing t.Cleanup for spawned goroutines/resources, time.Sleep as synchronization, and assertions that cannot fail.
- A test that passes for the wrong reason (zero-value fallback masking the real path) hides the production bug it claims to cover.

## Performance

- Only concrete regressions with a reachable hot path: per-iteration allocations or string concatenation added to a loop on a real call path, a new lock on a hot path, an O(n²) replacement for O(n). No reachable path, no finding.
