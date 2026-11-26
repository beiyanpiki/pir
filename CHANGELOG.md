# Changelog

## Unreleased

## v0.9.0 - 2026-11-26

### Highlights

- Added bounded parallel server review admission for API and Gitea requests, with global and per-project concurrency controls. Repository preparation, execution, and cleanup share the admission slot; maintenance work remains exclusive at the appropriate scope.
- Isolated concurrent reviews in fresh worktrees pinned to immutable commits, and serialized shared repository mutations with owner-aware cross-process resource locks. Purge and bundle-cache recovery refuse to remove repositories with active worktrees.
- Made finding display-ID allocation and insertion atomic to prevent collisions between concurrent writers.

### Upgrade notes

Both `--review-concurrency` (`PIR_REVIEW_CONCURRENCY`) and `--project-review-concurrency` (`PIR_PROJECT_REVIEW_CONCURRENCY`) default to `1`, preserving serial execution. Raise both for same-project parallelism; `2/2` is the recommended first rollout. These limits control admitted runs, not model requests: verifier concurrency and review angles can multiply provider traffic and cost.

Admission is process-local and queued work is not durable. Do not share state, repository, or config volumes between multiple serve instances. An orphaned repository `.break` mutex is never reclaimed automatically; stop the related processes and confirm none are running before removing the named file manually.

两个并发上限默认均为 `1`，保持原有串行行为；同项目并行需同时调高，首次灰度建议从 `2/2` 开始。它们限制准入运行数而非模型请求数，请留意验证并发和评审角度带来的流量与费用放大。准入队列仅存在于进程内，不支持重启恢复；多个 serve 实例不得共享状态、仓库或配置卷。遗留的 `.break` 互斥文件不会自动回收，需停止相关进程并确认无进程运行后，才可手动删除报错中指明的文件。

## v0.8.0 - 2026-11-24

### Highlights

- Added `--model-timeout <seconds>` to set a model request timeout per task, including reviewer and verifier requests. It is not a whole-run deadline.
- Updated the Pi coding-agent SDK, TypeBox, and Undici. The minimum supported Node.js version is now 22.19.0.
- Updated the web UI's DOMPurify dependency to 3.5.0 to address security advisories.

### Upgrade notes

The Docker image now bundles CodeGraph 1.6.4. Older indexes remain readable, but obtaining the updated extraction engine's parsing improvements requires a manual full rebuild: run `codegraph index <path>` with CodeGraph 1.6.4, replacing `<path>` with the repository path whose index you manage. Incremental `codegraph sync` does not re-extract unchanged files, and upgrading the image does not automatically rebuild user-managed indexes.

Docker 镜像现已内置 CodeGraph 1.6.4。旧索引仍可读取，但需使用 CodeGraph 1.6.4 手动运行 `codegraph index <path>` 全量重建，才能获得新版解析改进；`<path>` 是你管理的仓库路径。增量 `codegraph sync` 不会重新提取未修改的文件，升级镜像也不会自动重建用户管理的索引。
