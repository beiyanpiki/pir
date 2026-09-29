# Go audit verification playbooks

Falsification scripts per claim family. Every verdict ends in concrete confirming/counter evidence you read, or a specific missing-evidence statement — never a guess. This is a current-state audit: do NOT evaluate change attribution; age is never counter-evidence.

## Version gate — do this first

Read the `go` directive in go.mod at the snapshot; language semantics depend on it:

- go >= 1.22: loop variables DECLARED by the range clause (`for _, v := range`) are per-iteration — closure-capture claims about those are rejected unless the module pins an older version. A variable merely REUSED via `=` (`for _, v = range`) is still one shared variable: capture claims stand at any version. Read the declaration form before rejecting.
- go >= 1.20: the global math/rand auto-seeds — "predictable unseeded rand" claims are rejected UNLESS the deployment sets GODEBUG=randautoseed=0 (check runtime/deployment configuration before rejecting).
- Stdlib API availability (errors.Join, range-over-func/iterators, slices/maps helpers, synctest…) follows that version: for "this cannot compile" claims, check the API's introduction version against go.mod.
- Map iteration order randomization is the language spec — never a defect.

## Claim playbooks

- Goroutine leak: hunt the termination path — owner close, ctx cancellation reaching the blocking op, a buffered channel with capacity for every send, or bounded workers. A termination that fires on the claimed trigger REJECTS the leak. To confirm, show the specific send/recv that blocks forever, both endpoints included.
- Data race: locate BOTH access sites and show no mutex/channel/atomic covers them. "I didn't find a lock" is not counter-evidence — search enclosing methods and callers that hold one before confirming.
- Send-on-closed-channel / double-close: enumerate every close site and the ordering that lets a send land after close; moved or shared channel ownership is the usual cause. No concrete ordering → uncertain.
- Ignored error: show the ignored value can be non-nil on a reachable path AND matters downstream. An upstream handler/logger on the same path rejects the claim.
- Wrap-chain break (%v vs %w): show a caller doing errors.Is/As against the wrapped sentinel/type. No unwrapping caller reachable → downgrade or reject.
- Typed-nil interface: read the function's exact declared return type and the concrete type of the nil being returned; mismatched types cannot produce the effect.
- append aliasing: aliasing needs a shared backing array AND a write after the share point; an intervening growth/copy (full-slice expression, explicit copy) rejects.
- defer semantics: defer arguments and receivers evaluate at defer time; deferred closures observe named returns at run time. Verify which one the claim depends on before deciding.
- API/JSON compatibility break: grep the whole repo for the identifier and the JSON field string (fixtures, persisted samples, wire clients included). No caller and no serialized data rejects; out-of-repo consumers can at most make it uncertain.
- SQL injection: only request-influenced input reaching string-built SQL confirms; constant fragments and bound parameters reject.
- N+1: a batched query (JOIN, IN, preload) anywhere on the claim's path rejects the claim.
- Performance: read-only review has no benchmark and no -race — reason from the code's allocation/complexity structure and never defer a verdict to a tool that is not running here. No reachable hot path → uncertain, not confirmed.

Severity tracks impact, not cleverness: a real defect on an unreachable path is not P1.
