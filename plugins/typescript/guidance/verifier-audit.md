# TypeScript audit verification playbooks

Falsification scripts per claim family. Every verdict ends in concrete confirming/counter evidence you read, or a specific missing-evidence statement — never a guess. This is a current-state audit: do NOT evaluate change attribution; age is never counter-evidence.

## Config gate — do this first

Read tsconfig.json (compilerOptions) and package.json at the snapshot:

- strictNullChecks off: "the declared type is non-null" proves nothing — claims stand on runtime evidence or fail. With it on, escape hatches (`!`, `as`, any-typed boundaries, index signatures) still let null/undefined through.
- noUncheckedIndexedAccess / exactOptionalPropertyTypes absent: absence of the flag is absence of the guarantee, never evidence of safety.
- module/moduleResolution vs how the code actually runs: bundler resolution typechecks code Node rejects at runtime (ERR_MODULE_NOT_FOUND). "It compiles" is not counter-evidence under bundler resolution.
- typescript version in devDependencies: TS majors flip defaults and retire options (6.0 flipped strict/module/types/rootDir defaults and deprecated node10/es5/baseUrl; 7 turns those into hard errors) — gate every syntax, flag-default and "cannot compile" claim on the installed version.
- package.json type/exports/engines gate import-shape claims: require(esm) works only on Node >=20.19/22.12 AND a fully synchronous module graph — top-level await anywhere (dependencies included) fails require with ERR_REQUIRE_ASYNC_MODULE.

## Claim playbooks

- Floating promise: show it can reject on a reachable path AND no observer (await, .catch, race, structured runner) exists; a process-level unhandledRejection handler counts as an observer. A caller awaiting it rejects the claim.
- Null/undefined deref: show the concrete runtime source (JSON.parse, fetch, env, missing key, index access) — `!`/`as` assertions defeat compiler-based counter-evidence, the runtime shape decides. A compile-time-only possibility → uncertain.
- Assertion or predicate hides a mismatch: confirm runtime data actually diverges from the asserted/narrowed type on a reachable path; every reachable input matching the assertion → downgrade or reject.
- Race between parallel awaits: construct both interleavings and show one corrupts shared state; a sequential await, queue or mutex is counter-evidence.
- Listener/timer/stream leak: show the long-lived owner (server, worker, process) and the missing off/clear/close on every path; a one-shot process exit is counter-evidence.
- fetch non-2xx treated as success: confirm no res.ok/status branch on the claim's path AND a downstream consumer parsing the failure body as data; "fetch would throw" rejects — it rejects only on network errors.
- API/JSON compatibility break: grep the repo for the identifier and the serialized field names (fixtures, samples, persisted files, wire clients); runtime compatibility is shapes and field names, not declared types. No consumer and no serialized data rejects; out-of-repo consumers at most uncertain.
- ESM/CJS or exports-map break: verify against package.json type/exports and tsconfig module settings at the snapshot; bundlers and transpilers change the answer — prefer uncertain over confirmed when tooling-dependent. Dual-instance claims need both load paths (import and require) reachable in one process.
- SQL injection: only request-influenced input reaching string-built SQL confirms; constant fragments and bound parameters reject.
- N+1: a batched query (JOIN, IN, preload) anywhere on the claim's path rejects the claim.
- Performance: read-only review has no benchmark — reason from the code's allocation/complexity structure and the reachable path. No reachable hot path → uncertain, not confirmed.

Severity tracks impact, not cleverness: a real defect on an unreachable path is not P1.
