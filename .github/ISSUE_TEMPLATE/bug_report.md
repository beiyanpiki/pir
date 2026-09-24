---
name: Bug report
about: Something reviewed wrong, matched wrong, or blew up
labels: bug
---

## What happened

<!-- Concrete observation: command, expected vs actual. -->

```
$ pir ...
```

## Environment

- pir version (`pir version`):
- Deployment: local CLI / docker exec / HTTPS service (serve) / remote client
- Model provider/model (e.g. anthropic/claude-opus-4-8, zai-coding-cn/glm-5.3-flash):
- codegraph: installed+indexed / not installed (degraded mode)
- OS / Node version (for non-docker):

## Reproduction

<!-- Minimal repo steps or a patch that triggers the behavior. Include the
     finding id (F-n) if this is about a wrong verdict / suppression. -->

## Was memory involved?

- [ ] A prior feedback (expected / wont-fix / false-positive / ...) was or should have been applied
- [ ] The same issue keeps being re-reported after feedback
- [ ] A stale decision suppressed something it should not have
- [ ] Not memory-related

<!-- If yes: `pir findings show <id> --json` output helps (redact secrets). -->
