# pir

`pir` 基于 [Pi](https://github.com/earendil-works/pi) 评审 git 变更，也可以审计整个仓库。Reviewer 调查代码并提出候选缺陷，独立的 verifier 再检查每个候选的触发条件、影响和证据。结果同时包含已确认的问题和明确标记的不确定结论。

pir 会把仓库知识保存在 SQLite 中，包括项目规则、功能说明、符号契约、问题裁决和已验证的修复。这些知识为后续评审提供上下文；代码发生变化时，旧结论也会重新接受检查。

同一个包提供本地 CLI、Pi 扩展和 HTTPS 服务，三种入口共享应用服务与评审代码。

[English](../README.md) · [Agent 操作参考](for-llm.md)

## 评审什么

`pir find` 评审一段变更，查找由这次变更引入或暴露的问题。`pir audit` 审计一个已提交的快照，查找当前仓库中存在的问题。Audit 不要求缺陷归因于某次提交，也不包含未提交的文件。

评审循环有几个明确的边界：

- Agent 只读，通过评审工具调查代码，不能修改源文件、执行 shell 命令或写入决策类记忆。
- 来不及复核的候选会以 `candidate` 状态保留，与已报告的问题分开。
- `confirmed` 和 `uncertain` 是报告状态。被否决或因用户裁决而抑制的问题仍保留记录和理由。
- 后续遇到匹配的用户裁决时，verifier 会对照当前代码重新判断其适用性。代码变化可能让此前抑制的问题重新出现。

## 环境要求

- Node.js 22.5 或更新版本
- git
- 至少一个 Pi 支持的模型提供商的凭证；使用已配置的远程 `pir serve` 时，客户端无需这些凭证

## 安装

```bash
npx -y github:beiyanpiki/pir version
npm install --global github:beiyanpiki/pir
```

在源码目录中，`npm install --global .` 安装 CLI，`pi install .` 安装 Pi 扩展，提供 `/review-find`、`/review-audit`、`/review-memory`、`/review-feedback` 和 `/review-remember` 命令。

## 选择运行方式

本地执行和远程执行的前置条件不同，选一种即可。只使用远程服务时，客户端不需要配置本地模型。

### 本地模式

命令在当前仓库中运行，使用本机的 Pi 凭证。凭证通常位于 `~/.pi/agent/auth.json`：

```json
{ "anthropic": { "type": "api_key", "key": "<key>" } }
```

```bash
pir models
pir find --json
pir find --uncommitted --base HEAD --json
```

首次交互运行可以通过向导创建 `~/.pir/config.json`。最小本地配置是：

```json
{ "schemaVersion": 1, "mode": "local" }
```

加入 `"model": "provider/model"` 可以设置默认模型。选择顺序是 `--model`、`PIR_MODEL`、客户端配置中的 `model`，最后是 Pi settings。

### 远程模式

已有 `pir serve` 实例时，客户端只需要配置连接：

```bash
pir config set server.url https://pir.example.com:8790
pir config set server.token '<service-token>'
pir config set server.viewerToken '<web-token>'   # 可选:--web 界面 / runs 查询的凭据(#50)
pir config set server.insecure true   # 仅用于自签名证书
pir config set mode remote
pir config show                        # 查看生效配置;token 打码,文本与 --json 一致
pir find --uncommitted --base HEAD --json
```

```json
{
  "schemaVersion": 1,
  "mode": "remote",
  "server": { "url": "https://pir.example:8790", "token": "<token>" }
}
```

需要仓库上下文的命令会把本地状态打成 git bundle 发送给服务端，因此未推送的提交和未提交的工作区也可以送审，无需推送权限或源仓库凭证。`memory sync` 是特殊情况：它始终在本地执行，显式合并本地数据库与服务端数据库。

```bash
pir --local find --json
pir --server https://pir.example:8790 --token "$PIR_SERVER_TOKEN" --insecure \
  find --uncommitted --base HEAD --json
```

运行方式的优先级是 `--server`、`--local`、`PIR_SERVER_URL`、`PIR_MODE`，然后是 `~/.pir/config.json`。`serve`、`config`、`skill`、`plugins`、`version` 和 `memory sync` 始终在客户端执行。`--server` 与 `--local` 不能同时使用。客户端的默认模型不会转发给服务端；单次远程评审可以用 `--model` 覆盖服务端的选择。`--help` 出现在命令行任意位置都会在本地立即回答并退出 0——先于配置校验、传输解析、git 与网络,按子命令给出上下文帮助,因此离线、仓库外、只读 `.git`、配置损坏时均可使用。

需要自己托管服务时，在配置了模型访问的机器上运行：

```bash
PIR_SERVER_TOKEN='<service-token>' pir serve --host 0.0.0.0 --port 8790
```

直接安装在主机上的服务使用该机器的 Pi 模型设置和凭证。TLS 可以使用 `--cert`/`--key`、`PIR_TLS_CERT`/`PIR_TLS_KEY`，或在有 `openssl` 时自动生成自签名证书。

### Docker 服务

[Compose 配置](../docker-compose.yml) 用持久卷保存仓库和记忆。对应的 `.env` 设置是：

```dotenv
PIR_SERVER_TOKEN=<service-token>
PI_AUTH_JSON={"anthropic":{"type":"api_key","key":"<provider-key>"}}
PI_DEFAULT_PROVIDER=anthropic
PI_DEFAULT_MODEL=<model-id>
```

```bash
docker compose up -d
```

容器入口会把 `PI_AUTH_JSON`、`PI_API_KEY__<provider>` 和 `PI_DEFAULT_*` 转换为 Pi 配置。`sh docker/deploy.sh` 提供这一部署方式的交互式设置。

## 常用命令

```bash
pir find --json                         # HEAD^..HEAD
pir find --base origin/main --head HEAD --fail-on P1 --json
pir find --uncommitted --base HEAD --json # 暂存、未暂存和未跟踪的内容

pir audit --json                        # 已提交的 HEAD 快照
pir audit --path src/auth --path src/payments --json
pir audit --skip '**/generated/**' --json

pir findings list --status candidate
pir findings list --all --json        # 全量存储 findings(--limit/--offset 分页查询)
pir findings show F-12
pir feedback F-12 expected --note "retry_count counts attempts by design"
pir feedback F-12 priority P1
pir feedback F-13 fixed --note "Fixed in committed HEAD"
pir verify-fix F-13

pir memory status
pir memory bootstrap
pir memory refresh
pir remember symbol PaymentService.retry invariant --text "..."
pir memory sync --server https://pir.example:8790 --token "$PIR_SERVER_TOKEN"
```

`--max-findings` 是报告上限，不是要凑满的数量；`--max-findings unlimited` 彻底取消上限（#57，远端需要同版本 server）。JSON 结果的 `run.maxFindings`（无上限时为 `null`）与显式的 `run.maxFindingsMode`（`capped`/`unlimited`）一并输出。`--max-rounds` 用于变更评审；audit 由工作单元和可选的 `--max-tokens` 预算限制。未设置预算时，评审默认没有 token 上限。语言包默认自动检测，也可以用 `--plugins none` 禁用，或用逗号分隔的内置包名称指定。自带的 Go 和 TypeScript 包均支持 find 与 audit。注意区分:`findings list` 是**存储查询分页**(默认每页 100 条,JSON 输出携带 `total`/`returned`/`hasMore`/`nextOffset`,`--all` 一次取全量),与评审期的 `--max-findings` 上限是两个独立概念。

变更评审实际比较的是所选 ref 的 merge base 与 head。工作区评审显式设置 `--base HEAD`，可以把范围限定到未提交内容。`verify-fix` 会对照已提交的 HEAD 检查标记为 fixed 的问题。

## 输出协议

成功执行的 `--json` 命令向 stdout 写入一个结果信封。下面是简化的评审结果：

```json
{ "schemaVersion": 1, "command": "find", "data": { "findings": [], "incomplete": false } }
```

进度和诊断信息写入 stderr。退出码 `0` 表示未触发门禁失败，`1` 表示有已报告的问题达到 `--fail-on` 阈值，`2` 表示用法错误，`3` 表示运行错误。默认 `--fail-on none` 下，不完整结果仍可能返回 `0`，需要检查 `data.incomplete`。设置门禁后，不完整评审返回 `3`，除非已有达到阈值的问题使其返回 `1`。

Audit 还返回覆盖率记录。范围内文件分别记为 `reviewed`、`partial`、`unreviewed`、`blocked` 或 `failed`；被排除及未选中的文件另行统计。`reviewed` 表示流程完成，不表示已经找到了全部缺陷。

在投入长时间 audit 之前可以先预览范围（#56）：

```bash
pir audit --dry-run --list-files   # head/tree id、选择统计、计划的工作单元
pir audit coverage --latest        # 最近一次 audit run 的逐文件覆盖率
pir audit coverage --run <run-id>  # ……或指定某个 run
```

`--dry-run` 复用真实 audit 的快照与单元规划器，不建 run、不调模型；`coverage` 从本地项目库读取该 run 过程中持久化的覆盖率记录。

## 服务 API 与任务

`pir serve` 提供以下端点：

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 版本、TLS 状态和队列状态 |
| `POST /v1/exec` | 执行不使用 bundle 的 CLI 调用 |
| `POST /v1/review` | 基于 git bundle 执行仓库命令 |
| `POST /v1/memory/sync` | 将本地记忆快照与服务端合并 |
| `GET /v1/jobs` 和 `/v1/jobs/<id>` | 查看或取回异步任务 |

从本地 checkout 提交的远程 audit 默认使用异步任务，可以用 `pir jobs list`、`status`、`wait` 和 `fetch` 查看。任务注册表在内存中，保留最近 100 个已结束的任务；评审运行与 findings 保存在 SQLite 中。`PIR_REMOTE_ASYNC=1` 可以让其他评审命令也走异步提交。`find`/`audit --detach` 提交后立即返回（#53）：stdout 输出携带完整任务 id 与后续命令的提交信封，本地回执是持久记录——退出码 `0` 表示**已受理**，不表示评审成功。等待期间（`jobs wait` 或提交后的轮询）状态行在状态变化和约每分钟各打印一次（#55）：只报告连接存活，不虚构评审进度。

bundle 在一个临时 bare 仓库中打包，该仓库通过 alternates 只读取 checkout 的对象库（#46）：源仓库的 refs、index、config 和对象零写入，只读 `.git` 也可用。唯一例外是 `find --uncommitted`——它按设计先在源仓库记录工作区对象再打包。

远程响应等待时长依次为 `--remote-timeout <秒>`（0 禁用）> `PIR_REMOTE_TIMEOUT` > 配置 `server.timeoutSeconds` > 默认 1800 秒（#54）。异步任务轮询（5 秒间隔）没有总时限。

可选的只读浏览界面通过 `--web` 或 `PIR_WEB_UI=1` 开启，使用独立于 `PIR_SERVER_TOKEN` 的 `PIR_WEB_UI_TOKEN`。开启界面时，未设置的 `PIR_TRANSCRIPTS` 默认取 `1`，设置为 `0` 可以禁用转录。Compose 会传入这个变量，因此需要在 `.env` 中显式设置 `PIR_TRANSCRIPTS=1` 才能记录历史时间线。实时时间线覆盖 serve 进程中的评审；历史转录也能显示提示词、工具调用和可用的 thinking 内容。界面开发方式见 [web 文档](../web/README.md)。

### 按 URL 恢复运行

服务端接受异步评审时，客户端会在 `~/.pir/receipts/` 写入一张回执，记录服务器、任务 id、项目 id，以及任务落定后的 run id。`pir receipts list` 和 `pir receipts show <任务前缀>` 会列出回执和后续命令；回执在断连和服务端重启后依然可用（内存中的任务注册表则不能）。

只要服务端开启了 web 层，一个 run URL（`<origin>/runs/<projectId>/<runId>`）就足以在任何机器上查看和导出，不需要仓库和 git 权限：

```bash
pir runs status https://pir.example:8790/runs/<projectId>/<runId> --json
pir findings list --run https://pir.example:8790/runs/<projectId>/<runId> --all
pir findings show F-12 --run https://pir.example:8790/runs/<projectId>/<runId>
pir findings export --run https://pir.example:8790/runs/<projectId>/<runId> \
  --status confirmed --output findings.json
```

`findings export` 会翻完所有分页并拉取每条 finding 的完整详情，瞬时失败自动重试，原子写入（`.tmp` + rename），并保留 `<output>.checkpoint.json` 供中断续传。仍在运行的 run 导出当前快照并标记 `complete: false` 和 `snapshotAt`；已结束的 run 会校验导出数量与服务端总数一致。

web 层凭据与执行 token 相互独立（#50）：`--viewer-token` > `PIR_VIEWER_TOKEN` > 配置 `server.viewerToken`，两者绝不互为回退。env/配置中的 viewer token 只发送给它所属的服务器；指向别处的 run URL 需要显式传 `--viewer-token`。

## 状态与记忆

项目身份由规范化的远程 URL 和根提交决定，因此不依赖 checkout 路径或机器。普通本地状态位于平台状态目录下的 `pir/<projectId>/memory.sqlite`；服务端可以用 `PIR_STATE_ROOT` 集中存储。`PIR_MEMORY_DB` 和 `PIR_STATE_IN_PROJECT=1` 提供显式覆盖。

| 层 | 示例 |
| --- | --- |
| Project | 架构、职责、不变量 |
| Feature | 某个功能的行为语义 |
| Code entity | 符号契约与关系 |
| Issue decision | expected、false-positive、accepted-risk、wont-fix |
| Finding resolution | 已验证的修复及修复后状态 |

`memory sync` 双向合并记忆。同一记录发生冲突时，较新的版本胜出；`user_explicit` 和 `verified_fix` 知识优先于 agent 摘要。

## 更多文档

- [英文 README](../README.md)
- [Agent 执行参考](for-llm.md)
- [架构说明](design.md)
- [评审循环](review-loop.md)
- [Pi skill](../skills/pir/SKILL.md)

`pir skill install` 安装随包附带的 agent skill，`pir skill print` 可输出内容供其他集成使用。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm test
```

模型评估位于 `tests/eval/`，需要模型提供商访问权限。

## 许可

[MIT](../LICENSE) © 2026 Xin Gao
