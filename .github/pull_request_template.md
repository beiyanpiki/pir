<!-- Thank you for contributing to pir! Keep the scope tight: one PR, one purpose. -->

## What & why

<!-- What does this change do, and why is it the right approach? Link issues
     where relevant ("Closes #123"). -->

## Scope check

This PR intentionally does **not** touch (delete as inappropriate):

- [ ] the reviewer/verifier trust boundaries (decision memories stay user-only)
- [ ] the memory key scheme (projectId = remote + root commit; branches never key memory)
- [ ] the CLI stdout/exit-code contract (`--json` envelope, codes 0/1/2/3)
- [ ] the finding loop semantics (candidates always pass a verifier)

## Verification

- [ ] `npm run build` clean, `npm test` green (48+ tests; add tests for new behavior)
- [ ] Model-free tests cover the new logic (scripted sessions), or the gap is explained
- [ ] If behavior is model-dependent: describe the live verification performed (repo, command, outcome)

## Docs

- [ ] README / docs/README.zh-CN.md updated for user-facing changes
- [ ] docs/for-llm.md updated if the deployment surface or JSON contract changed
