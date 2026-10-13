# Frontend audit directions

These directions only sharpen where to look; every finding still needs the same causal evidence as any other claim. This is a current-state audit: no change attribution — a defect is in scope because it exists in the code now. Style, naming, formatting and CSS conventions are out of scope (eslint/prettier/stylelint territory, not defects). First read package.json, the lockfile, and the framework config at the snapshot (next/nuxt/svelte/astro/vite): framework and exact versions gate every version-dependent claim below — App Router vs Pages, Next's fetch-caching defaults, React 17 vs 18+ hydration semantics, Vue 2.7 vs 3 reactivity, Svelte 4 vs 5 runes. Establish how the audited surface renders (server page, prerendered, or client-only SPA): hydration and server-boundary claims are findings only where code really ships server HTML. When the audited surface contains no frontend code, leave these directions unused — do not invent frontend findings to fit them.

## Hydration and the server/client boundary

- Non-deterministic render output: Date.now()/Math.random()/crypto.randomUUID(), timezone- or locale-dependent formatting (toLocaleString, Intl), or reads of window.innerWidth/media during render — server HTML and first client render diverge.
- A `typeof window !== "undefined"` branch (or import.meta.env.SSR) that changes rendered markup is itself the mismatch, even when both branches work.
- Browser-only APIs (window, document, localStorage, matchMedia, observers) read during render instead of in an effect/onMounted: the server render crashes or skips, then the client re-renders differently.
- suppressHydrationWarning on a wrapper instead of the one known-mismatched element: it silences the whole subtree and hides the next real defect.
- useSyncExternalStore whose getServerSnapshot diverges from the first client getSnapshot.
- Invalid nesting — <div>/<ul> inside <p>, <a> inside <a>: the browser reparses server HTML before hydration attaches, so the client tree differs.

## Effects, races and leaks

- A fetch in an effect/watcher without abort or stale guard (AbortController tied to cleanup, ignore flag, seq counter): a slow earlier response landing after a newer one overwrites it — reachable whenever deps change or remounts are quick.
- Promise/timer/subscription callbacks writing state with no unmount path (React effect cleanup, Vue onUnmounted, Svelte onDestroy): late resolution writes into a dead component and pins its closure.
- Listeners, intervals, timeouts, observers (Resize/Intersection/MutationObserver), WebSocket/EventSource subscriptions without teardown on every path, early returns included.
- Dependency arrays that gate effect re-runs: a value read inside the effect but omitted (stale closure), or an object/array/function literal recreated per render (unbounded re-run/refetch loop). Lint suppression without a correctness reason is a suspect.
- A fetch path with no loading/error/empty branch: the reachable outcome is a blank region or an unhandled rejection. fetch resolves on 4xx/5xx — a call never checking res.ok parses error bodies as data.
- Index used as key on a reorderable/filterable/editable list: element state (input value, focus) attaches to the wrong item. Append-only static lists are counter-evidence.
- A controlled input that can render with value={undefined} (conditional spread, optional prop): React flips it to uncontrolled mid-life and the field loses state.

## XSS and client-side secrets

- dangerouslySetInnerHTML / v-html / {@html} / innerHTML / insertAdjacentHTML fed strings whose origin is user input, URL params, API/CMS/markdown content, with no sanitization on the path. A DOMPurify/server-side sanitize call on that path is counter-evidence.
- User-influenced URLs into href/src/action/formAction, window.open, or iframe src without scheme/host validation: javascript:/data: URIs execute; unvalidated http(S) URLs become open redirects.
- eval, new Function, or string-form setTimeout / setAttribute("on…") sinks.
- postMessage listeners without checking event.origin, or sends with targetOrigin "*": any embedding page can emit.
- Secrets reaching the client: NEXT_PUBLIC_*/VITE_*/NUXT_PUBLIC_* vars carrying private keys or tokens (inlined at build time), server-only modules (db, fs, $env/static/private) imported into a client component's graph, secret-bearing values passed as props to client components. Publishable identifiers are counter-evidence.
- Auth tokens in localStorage/sessionStorage while a same-origin httpOnly cookie path exists: XSS-readable storage; severity tracks what the token unlocks.
- UI-only permission gating (hidden button, client route guard) where the backend endpoint is visibly unguarded in-repo: any crafted request bypasses it.

## Framework boundary misuse

- Next App Router: functions, class instances or Dates passed as props from a server to a client component (not serializable — runtime error); "use client" module importing server-only code (pulls secrets into the client graph).
- Dynamic APIs (cookies(), headers(), searchParams) in a page meant to stay static: the route silently drops to per-request rendering. fetch cache options contradicting the data's freshness needs — gated on the Next major (14 caches GET fetch by default, 15 does not).
- Vue: destructuring props/reactive into plain constants drops reactivity; a ref read in the template but missing .value in script; mutating props; v-model on a computed with no setter.
- A component flipping between controlled and uncontrolled across renders loses or freezes input state.

## Performance (reachable hot paths only)

- A heavy dependency statically imported into the first-load bundle for marginal use (full lodash, moment+locales, chart libs) where a dynamic import or smaller API fits: confirm reachability from the entry import graph, not package.json alone.
- An unbounded list (thousands of rows) rendered directly into a scroll container without windowing.
- Scroll/resize/pointermove handlers interleaving layout reads (getBoundingClientRect, offsetTop) with writes, unthrottled and not passive: jank on every frame.
- Unbounded accumulation: arrays, state or DOM nodes appended per event/interval with no cap.
- Independent awaits serialized on the initial render path where Promise.all batches them; per-item awaits in a loop (request waterfall) on a reachable path.
- Deep copies (JSON.parse(JSON.stringify), structuredClone) or full sorts/filters of large collections re-run per render/keystroke on a hot path. "Could add useMemo" without a hot path is not a finding.

## Accessibility

- onClick on div/span/li with no role, keyboard handler or tabIndex: unreachable by keyboard and assistive tech. A native <button> is the fix.
- Form controls without an associated label (label[for], aria-label, aria-labelledby) — placeholder-as-label included.
- Icon-only buttons without an accessible name; informative <img>/svg without alt or aria-label.
- Menus/dialogs that never move focus into the overlay or close on Escape, while the codebase already establishes that pattern elsewhere.

## Tests

- Component tests mocked into triviality: the store/router/fetch seam replaced so the assertion proves nothing; user-event interactions not awaited (floating assertions); whole-tree snapshots regenerated on every tweak and read by nobody.
- Tests asserting implementation details (wrapper.props().x, internal selectors) that pass while behavior regresses.
