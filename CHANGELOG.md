# Changelog

## Unreleased

### Upgrade notes

The Docker image now bundles CodeGraph 1.6.4. Older indexes remain readable, but obtaining the updated extraction engine's parsing improvements requires a manual full rebuild: run `codegraph index <path>` with CodeGraph 1.6.4, replacing `<path>` with the repository path whose index you manage. Incremental `codegraph sync` does not re-extract unchanged files, and upgrading the image does not automatically rebuild user-managed indexes.

Docker 镜像现已内置 CodeGraph 1.6.4。旧索引仍可读取，但需使用 CodeGraph 1.6.4 手动运行 `codegraph index <path>` 全量重建，才能获得新版解析改进；`<path>` 是你管理的仓库路径。增量 `codegraph sync` 不会重新提取未修改的文件，升级镜像也不会自动重建用户管理的索引。
