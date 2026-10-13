# Frontend verification playbooks

Falsification scripts per claim family. Every verdict ends in concrete confirming/counter evidence you read, or a specific missing-evidence statement — never a guess.

## Config gate — do this first

Read package.json, the lockfile, and the framework config at head:

- Exact installed versions gate every claim: react/react-dom major (17 hydrate vs 18+ consolidated mismatch errors), next major (13 App Router vs Pages; 14 caches GET fetch by default, 15 does not), vue (2.7 defineProperty vs 3 Proxy/script-setup), svelte (4 stores vs 5 runes). "The docs say" without the installed version rejects.
- Rendering mode decides hydration reachability: confirm the component actually renders on the server (framework route, prerender config). A client-only mount (dynamic import with ssr:false, SPA entry, first render inside an effect) rejects hydration-mismatch claims.
- Server timezone/locale vs the browser's: a mismatch claim needs evidence both sides differ (server TZ env, Intl data). A fixed locale argument or pinned TZ on both sides rejects; otherwise uncertain.

## Claim playbooks

- Hydration mismatch: name the two divergent outputs (server string vs client string) and the reachable render producing each. suppressHydrationWarning scoped to exactly the mismatching element is accepted mitigation; on a wrapper it hides siblings and confirms.
- Stale-response race: construct both orderings (slow A, fast B) and show A's write lands last with no guard; an AbortController wired to cleanup/dep change, an ignore flag, or a seq check rejects. StrictMode double-invoke is dev-only, not a production path.
- Leak: show the long-lived owner (window, document, module store) and the missing teardown on every path; a listener whose owner dies with the component, or accumulation only under HMR, rejects.
- Stale closure: show the value the closed-over binding holds at the reachable execution vs the fresher value the effect needs; a dep entry or ref read rejects.
- XSS: trace source→sink concretely (route param/API field → state → innerHTML/href). Sanitization on the path (DOMPurify, server-side bleach, framework auto-escaping intact) rejects; author-controlled static strings are at most uncertain; attacker-influenced taint with no boundary confirms. javascript:-URL claims need a user-influenced construction path.
- Secret in client bundle: show the client-side reference (NEXT_PUBLIC_/VITE_ var, import into a "use client" graph) AND that the value class is private (key material, tokens, connection strings). Publishable keys and values already public in-repo reject.
- Server→client boundary break: the prop must be constructed server-side and consumed by a "use client" component — both sides read. Client→client data flow rejects.
- Performance: read-only review has no benchmark — reason from the code's allocation/complexity structure and the reachable path (row counts, event frequency, entry-graph reachability for bundle claims). No reachable hot path → uncertain, not confirmed.
- Accessibility: confirm the element lacks every accessible path (aria-label, aria-labelledby, native button/input alternative, keyboard handler) before confirming; an existing alternative is counter-evidence.

Severity tracks impact, not cleverness: a real defect on an unreachable path is not P1. Attacker-reachable XSS and shipped secrets are P0/P1; interaction-breaking hydration or a data-losing race P1; cosmetic-only mismatch or off-hot-path jank P3.
