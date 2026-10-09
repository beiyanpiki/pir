---
name: work-with-pr
description: "Full PR lifecycle for developing pir itself (github.com/beiyanpiki/pir, any worktree of it): implement in an isolated sibling git worktree → local gates (npm typecheck/test + pir-dogfood self-review with findings fixed) → PR to dev following the repo's PR template → CI verification loop on the self-hosted runner → merge commit → worktree cleanup. Splits work into the smallest atomic, independently mergeable PRs and builds independent ones in parallel. Use whenever implementation work on this repo needs to land as a PR: 'create a PR', 'implement and PR', 'implement issue #N', 'land this as a PR', 'split into atomic PRs', '提 PR', '提个 PR 再合并', 'work-with-pr', even when the user just says 'implement X' if PR delivery is implied. NOT for other repositories — there use the plain git/gh flow."
---

# Work With PR — pir development PR lifecycle

You are executing a complete PR lifecycle for pir: from an isolated
task-owned worktree, through implementation with model-free tests and
real-surface QA, a dogfood self-review gate, PR creation against `dev`, an
unbounded verification loop (CI + dogfood), to merge and worktree cleanup.
A failing gate sends you back into that PR's worktree to fix and re-QA; you
keep cycling until every gate passes on the exact code being pushed.

**The unit of delivery is the smallest PR that compiles, passes, and stands
on its own — not "one task, one PR."** A single task routinely splits into
several atomic PRs; the lifecycle below describes ONE of them, so apply it
to each, and build the independent ones concurrently (Phase 0).

<architecture>

```
Phase 0: Setup         → Split into atomic PRs, then branch + sibling worktree per PR
                         (parallel when independent, one subagent per PR)
Phase 1: Implement     → One slice per PR: model-free tests + real-surface QA
                         (drive the built CLI), atomic conventional commits
Phase 2: PR Creation   → Push, create PR to the base branch (dev, or the
                         parent branch of a stack) filling the repo's PR template
Phase 3: Verify Loop   → Unbounded iteration; a failing gate routes back to Phase 1:
  ├─ Gate B: dogfood   → this worktree's build reviews its own diff (local,
  │                     runs BEFORE every push, never skipped for findings)
  └─ Gate A: CI        → gh pr checks on the self-hosted pir-self-runner
                         (npm ci → typecheck → build → test)
Phase 4: Merge         → merge commit (--merge, never squash/rebase), then
                         worktree cleanup and final report
```

</architecture>

---

## Phase 0: Setup

Create a fresh isolated worktree for each PR before implementation starts.
The user's main working directory is read-only context — it may hold
uncommitted work, and a branch checkout there would destroy it. Isolation
also makes parallelism cheap: one worktree per PR, so several build at once
without colliding.

<setup>

### 1. Decide the PR split

Decompose the task into the smallest atomic PRs that each compile, pass,
and deliver one reviewable slice. Prefer more small PRs over one large one
— a 200-line PR gets a real review; a 2000-line PR gets a rubber stamp.
Sequence by dependency: independent slices branch off `origin/dev` and run
in parallel; dependent slices stack, each branched off the previous. A PR's
base is therefore `dev` for an independent slice and its parent branch for
a stacked one — carry that as `$BASE_REF` (git side) and `$BASE_BRANCH`
(PR side) through every phase below instead of assuming `dev`.

Building more than one independent PR concurrently is the recommended
default, not an exotic option: run one subagent (or separate agent
session) per PR — however your environment expresses parallel work — each
owning its own worktree, branch, and the full Phase 0→4 lifecycle. Each
subagent's brief must be self-contained: the task slice, the branch name,
the worktree path, and an instruction to read this SKILL.md and
`.agents/skills/pir-dogfood/SKILL.md` before starting. If parallel
subagents aren't available, build the independent PRs sequentially — the
isolation comes from the per-PR worktree, not from parallelism.

### 2. Create branch + worktree

Branch names follow this repo's convention: `<type>/<slug>` where type is
`feat` / `fix` / `ci` / `chore` / `docs`, optionally carrying the issue
number (`feat/issue-42-long-audit-ops`). Use the user's branch name when
they provide one.

```bash
cd <main repo dir>          # read-only context; never implement here
git fetch origin dev
BRANCH="feat/short-slug"
BASE_REF="origin/dev"; BASE_BRANCH="dev"   # stacked PR: both = parent branch
git branch "$BRANCH" "$BASE_REF"

WORKTREE="../pir-wt/$BRANCH"   # siblings of the repo, never inside it
mkdir -p "$(dirname "$WORKTREE")"
git worktree add "$WORKTREE" "$BRANCH"

cd "$WORKTREE"
npm install                 # root install covers the web/ workspace too
```

</setup>

---

## Phase 1: Implement

<implementation>

### Scope discipline

Within each PR, stay minimal: deliver its one slice, add the test, prove
it, stop. Do not refactor surrounding code, add config options, or
"improve" things that aren't broken — that work belongs in its own PR, and
scope creep makes failures harder to isolate.

### QA bar

This repo's PR template defines what "done" means; honor it:

- **Model-free tests are the default proof.** New logic gets scripted-
  session tests under `tests/unit/` or `tests/integration/` (fake codegraph
  binaries, scripted agent sessions — see existing tests for the pattern).
  `npm test` runs them all.
- **Model-dependent behavior needs live verification on the real surface.**
  Drive the built CLI — `node dist/cli/cli.js …` — against a real scenario
  and record the command and observed outcome; it goes into the PR's
  Verification section. "It typechecks" and "`npm test` is green" are NOT
  QA for model-dependent behavior.
- Docs-only PRs say so explicitly in Verification instead of inventing QA.

### Commit strategy

Conventional commits, as the history shows
(`fix(cli): exempt URL-keyed findings recovery from the first-run wizard
(dogfood F-55)`). When a commit fixes a dogfood finding, suffix the message
with `(dogfood F-N)` so the review loop stays auditable. Keep commits
atomic so a CI failure can be isolated and fixed without unwinding
everything:

```
3+ files changed  → 2+ commits minimum
5+ files changed  → 3+ commits minimum
10+ files changed → 5+ commits minimum
```

Each commit pairs implementation with its tests.

</implementation>

---

## Phase 2: PR Creation

<pr_creation>

```bash
cd "$WORKTREE"
git push -u origin "$BRANCH"
```

Write the PR body in English by explicitly filling this repo's template
(`.github/pull_request_template.md`) — do not rely on an editor opening:

- **What & why** — plain-language what changed and why this approach;
  link issues ("Closes #N").
- **Scope check** — the template's invariant list (trust boundaries, memory
  key scheme, CLI stdout/exit-code contract, finding loop semantics). Keep
  the items that hold; delete the ones that don't apply. If the PR
  intentionally touches one of those invariants, delete that item and
  explain it under What & why so a reviewer cannot miss it.
- **Verification** — build/test status, the model-free tests added, and for
  model-dependent behavior the live verification performed (repo, command,
  outcome). Include the dogfood review result (findings fixed / clean /
  skipped-with-reason).
- **Docs** — README + docs/README.zh-CN.md for user-facing changes;
  docs/for-llm.md if the deployment surface or JSON contract changed.

Cite sanitized artifacts only; never paste raw secret-bearing logs, env
dumps, tokens, or auth headers into the PR.

```bash
gh pr create --base "$BASE_BRANCH" --title "$TITLE" --body "$(cat <<'EOF'
## What & why
…

## Scope check
…

## Verification
…

## Docs
…
EOF
)"
PR_NUMBER=$(gh pr view --json number -q .number)
```

</pr_creation>

---

## Phase 3: Verification Loop

This is the core of the skill. Every gate must pass for the exact code
being pushed. Gate order is intentional: the dogfood review is local and
free of CI round-trips, so it runs FIRST and before every push; CI runs on
push. The loop has no iteration cap — a failing gate is not a
patch-and-push: route back to Phase 1, where fixes get the same scope
discipline and, if behavior changed, fresh QA evidence.

**Invariant: never push code that has not passed typecheck + tests + a
dogfood review in exactly that form.**

<verify_loop>

```
while true:
  1. Local checks       → npm run typecheck && npm test  (test builds first)
  2. Gate B: dogfood    → review the committed branch diff from this worktree;
                          findings → Phase 1 fix loop, then back to 1
  3. Push               → git push
  4. Gate A: CI         → wait via background `gh pr checks --watch --fail-fast`;
                          failure → read logs → Phase 1 fix loop → back to 1
  5. CI green           → break
```

### Gate B: pir dogfood review (local, runs before every push)

pir reviews its own changes with the code under development — the full
invocation contract lives in `.agents/skills/pir-dogfood/SKILL.md`; read it
before the first run. Canonical form from inside the worktree:

```bash
npm run build    # review with the code you just wrote, never a stale dist/
PIR_CONFIG_DIR=/tmp/pir-dogfood-config PIR_NO_WIZARD=1 \
  node dist/cli/cli.js find --local --json --fail-on P1 \
  --model 'zai-coding-cn/glm-5.3:max' --base "$BASE_REF"
```

`--base "$BASE_REF"` reviews the committed branch diff against the PR's
base — `origin/dev` for an independent PR, the parent branch for a stacked
one, so a stacked review sees only its own slice; add `--uncommitted`
while mid-work. Exit 1 means a P0/P1 finding is present; with `--json`,
stdout is pure JSON (`data.findings[]` with `displayId` F-N, `severity`,
`status`, `claim`, `verifierRationale`, `memoryMatches[]`).

Triage each finding the way you would treat code-review feedback: verify
it against the code first — neither blind-fix nor blind-dismiss:

- **valid** → fix it; commit message suffixed `(dogfood F-N)`; then mark it
  `feedback F-N fixed --note "…"` (verify-fix refuses until you do) and
  confirm with `verify-fix F-N` or a re-run;
- **false positive** → `feedback F-N false-positive --note "…"` so repo
  memory records the verdict;
- **intentional** → `feedback F-N expected --note "…"`.

All feedback/verify-fix commands use the same env prefix and `--local` as
the review. Repo memory is a local SQLite keyed by origin + root commit, so
all worktrees of this repo share it — and dogfooding never syncs it.

This gate is never skipped because it found issues. The only legitimate
skip is missing model credentials (no usable id from `models --ids`, or no
`~/.pi/agent/auth.json`): then record Gate B as SKIPPED (credentials) in
the final report — visibly, never silently.

### Gate A: CI

CI (`.github/workflows/ci.yml`) runs npm ci → typecheck → build → test on
the self-hosted `pir-self-runner`. Wait for it without burning agent
round-trips: run `gh pr checks "$PR_NUMBER" --watch --fail-fast` in the
background if your environment supports background commands, so the
finished watch wakes you; otherwise check one-shot
`gh pr checks "$PR_NUMBER"` at spaced intervals. Never tight-loop on a
blocking foreground watch.

**Self-hosted runner caveat:** checks sitting queued with nothing running
usually means the runner box is down — that is an infra failure (see
Failure Recovery), not a loop iteration. Don't re-push hoping to nudge it.

On failure, get the logs before touching anything:

```bash
RUN_ID=$(gh run list --branch "$BRANCH" --status failure --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --log-failed
```

### Iteration discipline

Each pass through the loop:

1. Fix ONLY the issues identified by the failing gate — no drive-by fixes
2. If the fix changes runtime behavior, capture fresh QA evidence (Phase 1)
3. Commit atomically (`(dogfood F-N)` suffix when applicable)
4. Re-run local checks + dogfood (code changed → full re-verification)
5. Push; re-enter at Gate A

</verify_loop>

---

## Phase 4: Merge & Cleanup

Once CI is green and the dogfood gate is satisfied (or SKIPPED with a
recorded reason):

<merge_cleanup>

### Merge (default) — merge commits only

Merging is the default unless the user explicitly opted out. This repo's
history is merge commits: use `--merge`, never `--squash` or `--rebase` —
squashing would erase the atomic dogfood-fix history the loop just built.

```bash
cd <main repo dir>   # not the worktree: the branch is checked out there
gh pr merge "$PR_NUMBER" --merge --auto --delete-branch \
  || gh pr merge "$PR_NUMBER" --merge --delete-branch
# --auto arms GitHub's auto-merge (lands when required checks pass);
# if the repo has auto-merge disabled, --auto errors and the fallback
# merges directly once the gates are green.
```

If a required human review blocks auto-merge, say so and leave the PR
ready for the user — do not try to force it. Wait for the merge itself the
same way as CI: watch `gh pr view "$PR_NUMBER" --json state -q .state`
until MERGED, in the background or at spaced intervals — never a blocking
poll.

If the user opted out of merging, skip the merge but STILL run the cleanup
below: the worktree is removed either way.

### Clean up the worktree

```bash
cd <main repo dir>
git worktree remove "$WORKTREE"
git worktree prune
```

### Report completion

```
## PR Complete

- **PR**: #{PR_NUMBER} — {PR_TITLE}
- **Branch**: {BRANCH} → dev
- **Iterations**: {N} verification loops
- **Gates**: CI pass | dogfood {pass (N findings fixed) | SKIPPED (credentials)}
- **Merged**: {yes | no — left for you to merge, as requested}
- **Worktree**: cleaned up
```

</merge_cleanup>

---

## Failure Recovery

<failure_recovery>

If you hit an unrecoverable error (merge conflict with the base branch,
self-hosted runner down, auth failure):

1. **Do NOT delete the worktree** — the user may want to inspect or
   continue manually
2. Report what happened, what was attempted, and where things stand
3. Include the worktree path so the user can resume

For base-branch drift or push rejections:

```bash
cd "$WORKTREE"
git fetch origin dev
git rebase "$BASE_REF"     # origin/dev, or the parent branch of a stack
# resolve conflicts, re-run Phase 3 from local checks (code changed),
# then push --force-with-lease to the PR branch
```

</failure_recovery>

---

## Anti-Patterns

| Violation | Why it fails | Severity |
|-----------|-------------|----------|
| Working in the main repo dir instead of an isolated worktree | Pollutes user's working directory, may destroy uncommitted work | CRITICAL |
| Pushing without a dogfood pass on exactly that code | Reviewing yourself is this repo's whole point; skips cost real findings later | CRITICAL |
| Pushing directly to dev | Bypasses PR review entirely | CRITICAL |
| Pushing fixes without re-running local checks + dogfood | Code changed → previous gates are stale | CRITICAL |
| Skipping dogfood because it found issues | Findings must be fixed or recorded via `feedback`, never dodged | HIGH |
| Fixing unrelated code during the verification loop | Scope creep causes new failures | HIGH |
| Deleting the worktree on failure | User loses the ability to inspect/resume | HIGH |
| Blindly implementing or dismissing dogfood findings | Each finding gets verified against the code; dismissals are recorded with a reason | MEDIUM |
| Bundling independent slices into one big PR | Atomic review dies; one bad slice blocks all the others | HIGH |
| `--squash` / `--rebase` merges | Erases the atomic dogfood-fix commit history | MEDIUM |
| Not running local checks before push | Wastes a CI round-trip on obvious failures | MEDIUM |
