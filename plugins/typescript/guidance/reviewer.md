# TypeScript review directions

These directions only sharpen where to look; every finding still needs the same causal evidence as any other claim. Style, naming and formatting are out of scope (prettier/eslint territory, not defects). First read tsconfig.json and package.json at head: strict flags, module/moduleResolution, target/lib, `"type"`, engines, and the installed typescript version gate every config- and version-dependent claim below.

## Null, undefined and escape hatches

- `!` and `as` added by this change silence the compiler, not the runtime: JSON.parse, fetch bodies, process.env, argv and index lookups return what the wire or OS gave, never the declared type. A dereference behind a fresh assertion needs runtime evidence.
- Boundary data (JSON, HTTP, env, config, persisted) crossed with `as`/`any` instead of parsed: the assertion is a claim about every future input, not a check.
- `??` vs `||`: 0, "" and false are real values; a fallback this change added with `||` silently replaces them.
- Optional chaining moves the crash, it does not fix it: `a?.b.c` turns "a is null here" into "c of undefined three frames later", with the context lost.
- With noUncheckedIndexedAccess off, `arr[i]`/`map[key]` can be undefined at runtime; new code trusting indexed access on possibly-missing keys is a suspect.
- exactOptionalPropertyTypes off: assigning undefined to an optional key differs from omitting it — Object.keys and JSON.stringify (which drops undefined fields) observe the difference; check consumers when this change switches between the two.

## Async and the event loop

- Every promise this change creates needs an owner: awaited, returned, or handed to detached-work machinery with cancellation and rejection handling. A fire-and-forget call that can reject on a reachable path is an unhandledRejection (silent or process-fatal).
- forEach/map with an async callback does not await it: any sequencing assumption about that loop is wrong, and forEach's undefined return hides the promise entirely.
- Promise.all fail-fast abandons siblings still running, so their rejections land unobserved; callers that need every outcome need allSettled — check who consumes failures.
- Parallel awaits (Promise.all, detached calls) writing state this change also touches sequentially: the interleaving the code assumes must be the only possible one.
- AbortController/timeout created but never passed into the actual I/O (fetch, db driver, stream): cancellation must reach the operation, not sit alongside it.
- Cleanup (release, unlock, close, temp-file delete) only on the happy path leaks on throw/early-return — it needs finally.
- Listeners (on/addListener) or intervals added per request/iteration without removal accumulate across a long-lived process.
- Unconsumed response/stream bodies pin memory and sockets; a piped stream with no 'error' handler crashes the process.

## Types vs runtime (erasure)

- Runtime sees no types: instanceof, Array.isArray, `in`, and serialized field names are all that survives. Two structurally identical types are indistinguishable at runtime — branching that assumes nominal distinction is defective.
- A type predicate (`x is T`) or assertion function written by this change is trusted by every branch it feeds; a loose predicate poisons all of them downstream.
- A switch over a union this change extended, with a default branch, silently mishandles the new variant — nothing forces exhaustiveness.
- `@ts-ignore` never expires (unlike @ts-expect-error, which errors once the underlying error disappears): a suppression added by this change hides its error forever. A finding only when what it hides can matter at runtime.
- any arriving via untyped imports (missing @types, `declare module`, untyped library returns): checking stops at that call, so downstream null/shape handling is unchecked.

## Modules and ESM/CJS

- bundler resolution (or extension-less relative imports) on code Node loads unbundled: typechecks locally, throws ERR_MODULE_NOT_FOUND at runtime. The consumption model decides.
- Adding or narrowing `"exports"` makes every previously reachable deep import unresolvable — semver-major for consumers; so is reordering conditions (types must stay first, default last) or moving entry files.
- Dual-format packages can load twice in one process (import plus require via different paths): instanceof, singletons and module-level caches silently break across the two instances.
- Circular imports added by this change: initialization order yields undefined at use time.
- ESM specifics: `__dirname`/`require` don't exist; `import type` is erased; top-level await anywhere in the module graph makes the package un-require()able for CJS consumers.
- A runtime import of a devDependency (or of files outside the `files` whitelist) is a publish/install break the type checker cannot see.

## Errors, secrets and backend boundaries

- Expected failures thrown where callers cannot distinguish them, or swallowed (`catch {}`, catch-log-continue), on a path this change touched — trace which layer owns reporting; handling the same error twice (log plus rethrow) duplicates or loses context.
- fetch resolves on 4xx/5xx (only network errors reject): a new call without a res.ok/status check parses error bodies as data.
- SQL via template-string concatenation with request-influenced values is injection; bound parameters are the contract — check placeholder arity and ordering against args.
- awaits inside a loop over rows/items this change added is N+1; a JOIN/IN batch on the same path is counter-evidence.
- API compatibility: exported signature changes, JSON field renames, optional→required flips — check in-repo callers AND serialized/persisted data. Serialization erases: undefined fields vanish in JSON.stringify, Date becomes string, class instances lose methods.
- New outbound calls without timeout/abort hang forever against a stuck server; request bodies parsed without a size cap.
- Secrets (tokens, keys, PII) into logs, errors or serialized diagnostics this change adds; thrown values or process.env serialized into telemetry.

## Tests changed by this diff

- Tests that cannot fail: assertions inside swallowed catches, expect without await (a floating assertion), mocks resolving shapes the real module never returns.
- Module mocks replacing the production seam hide the defect the test claims to cover; fake timers/env/process mocks not restored poison later tests.

## Performance

- Only concrete regressions with a reachable hot path: sync fs/exec/crypto (pbkdf2, scrypt, gzip) blocking the event loop on a request/iteration path; O(n²) via .includes/.find/.concat inside a loop; JSON.parse(JSON.stringify()) deep clones; unbounded accumulation over streamed chunks; catastrophic-backtracking regexes on request-influenced input. No reachable path, no finding.
