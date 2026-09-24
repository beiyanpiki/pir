# pir — pi-based code review with Repository Memory

`pir` 是基于 [Pi](https://github.com/earendil-works/pi) 的代码审查引擎:它只做一件事——**尽可能准确地发现"本次变更引入的问题",并通过项目历史知识降低误报**。不集成 GitHub/PR 评论/CI/自动修复。支持本地运行、Pi extension、CLI,以及 [Docker](#docker)(exec 直调 + HTTPS 服务)。

单一 npm 包,两个入口,共享同一套用例逻辑:

- **Pi extension**:`/review-find`、`/review-memory`、`/review-feedback`、`/review-remember`
- **CLI `pir`**:供其他 agent 工具(Claude Code hook、cron、CI、任何能起子进程的 agent)以稳定 JSON 协议调用

## 安装

```bash
npm i -g .            # CLI: pir
pi install $(pwd)     # extension: /review-* 命令
# 或者开发模式:
pi --extension ./dist/extension/index.js
```

前提:Node ≥ 22.5(`node:sqlite`)、git、已配置模型的 pi。可选 `codegraph`(结构性查询,缺失时自动降级为文件级审查)。

**模型接入(智谱官方 GLM)**:pi 内置 `zai-coding-cn` provider(coding 订阅端点)。把你的 bigmodel key 写入凭证存储即可:

```bash
# ~/.pi/agent/auth.json  (chmod 600)
{ "zai-coding-cn": { "type": "api_key", "key": "<你的bigmodel key>" } }
# 或环境变量: export ZAI_CODING_CN_API_KEY=<key>
```

默认模型在 `~/.pi/agent/settings.json` 里设 `defaultProvider: "zai-coding-cn"`、`defaultModel: "glm-5.3-flash"`、`defaultThinkingLevel: "low"`(GLM 仅接受 low/high/max)。

## CLI 协议(给 agent 用的契约)

**stdout 只输出结果**(`--json` 时是带 `schemaVersion: 1` 信封的纯 JSON);进度/日志一律 stderr,不污染管道。

```bash
pir find [--base <ref>] [--head <ref>] [--json]
         [--max-rounds N] [--max-tokens N]
         [--fail-on P0|P1|P2|P3|none] [--model <id>] [--no-sync-index]
pir memory status|bootstrap|refresh [--json] [--max-batches N] [--model <id>]
pir feedback <findingId> <decision> [--note "..."] [--json]
pir feedback <findingId> priority P0|P1|P2|P3
pir remember project|feature <key>|symbol <key> invariant|note|risk --text "..." [--json]
pir findings [list [--status <s>]] [--json]
pir findings show <id> [--json]
pir verify-fix <findingId> [--json]
pir version
```

全局:`--json`、`--cwd <path>`、`--quiet`、环境变量 `PIR_MEMORY_DB`(覆盖 memory.sqlite 位置)。

**决策集**:`confirmed | expected | false-positive | accepted-risk | wont-fix | fixed | obsolete`

**退出码**:`0` 正常;`1` 存在 ≥ `--fail-on` 级别的已报告 findings;`2` 用法错误;`3` 运行时错误。

find 的 finding 字段:

```json
{
  "displayId": "F-12", "title": "...", "claim": "...", "trigger": "...",
  "category": "correctness", "severity": "P1", "status": "confirmed",
  "featureKey": "payment-retry", "entityKey": "PaymentService.retry",
  "anchors": [{"path": "src/pay.ts", "startLine": 41}],
  "evidence": [{"kind": "code", "path": "src/pay.ts", "startLine": 41, "excerpt": "..."}],
  "memoryMatches": [{"decision": "expected", "stillApplies": true, "source": "user_explicit"}],
  "verifierRationale": "...", "round": 1
}
```

### 典型 agent 工作流

```bash
pir find --json --fail-on P1                       # 审查 HEAD^..HEAD
pir feedback F-12 expected --note "intentional"    # 反馈写入长期记忆
pir find --json                                     # 同类问题不再打扰你
pir verify-fix F-13                                 # 验证修复确实消除了触发路径
```

## Docker

单一镜像,两种用法,**所有状态(`.pir/memory.sqlite`)都落在项目目录内**(`PIR_STATE_IN_PROJECT=1`),容器销毁不丢、可随仓库归档:

```bash
docker build -t pir:latest .

# ① exec 模式:像本地 CLI 一样直接调用
docker run --rm -v $PWD:/workspace pir:latest find --json
docker run --rm -v $PWD:/workspace pir:latest feedback F-1 expected --note "..."
ls .pir/          # memory.sqlite 就在你的项目里

# ② HTTPS 服务模式(自签 TLS + Bearer 认证)
docker run -d --name pir-serve -p 8790:8790 \
  -v $PWD:/workspace -v ./docker/pi-config:/pi-config:ro \
  -e PIR_SERVER_TOKEN=secret -e BIGMODEL_API_KEY=<bigmodel-key> \
  pir:latest serve

# 同一个 pir CLI 作为远端客户端调用:
pir --server https://127.0.0.1:8790 --token secret --insecure find --json
```

或 `docker compose up -d`(见 [docker-compose.yml](docker-compose.yml),需 `.env` 提供 `PIR_SERVER_TOKEN`/`BIGMODEL_API_KEY`,已被 gitignore)。

要点:

- **模型配置**:走 pi 内置的 `zai-coding-cn` provider(智谱官方 coding 端点 `open.bigmodel.cn/api/coding/paas/v4`,含 glm-5.3 / glm-5.3-flash 模型目录与 thinking 级别映射)。容器传入 `BIGMODEL_API_KEY`,entrypoint 生成 0600 的 `auth.json`——密钥不进镜像、不落 git;`/pi-config` 挂载可覆盖完整 pi 配置(会先播种到容器内可写目录,pi 需要写 auth 存储)。
- **服务协议**:`GET /health`;`POST /v1/exec {"argv": ["find", "--json", ...]}` → `{code, output, log}`,命令串行执行,`--cwd` 被限制在 workspace 内;usage 错误按 CLI 语义返回 code=2。远端客户端自动剥离 `--server/--token/--insecure` 后转发。
- **TLS**:`--cert/--key` 或 `PIR_TLS_CERT/PIR_TLS_KEY` 提供正式证书;否则容器内用 openssl 自签(持久化于 `PIR_CERT_DIR`);`PIR_ALLOW_HTTP=1` 可显式降级明文。客户端用 `--insecure` 接受自签证书。
- 镜像内置 git/ripgrep/openssl 与可选的 codegraph(`INSTALL_CODEGRAPH=0` 构建参数可去掉);git 已设 `safe.directory '*'` 以接受挂载仓库。

## Repository Memory(与普通 AI review 的区别)

审查会话是一次性的(`SessionManager.inMemory()`,用完即 `dispose()`),长期知识存在独立的 SQLite(默认 `~/.local/state/pir/<projectId>/memory.sqlite`,`projectId = sha256(normalizedRemote + rootCommit)`,换目录/换机器不丢):

| 层 | 内容 | 例子 |
|---|---|---|
| Project | 架构/职责/不变量 | "financial writes must be idempotent" |
| Feature | 垂直功能的语义 | "payment-retry: 每次 attempt 前消耗配额" |
| Code Entity | symbol 级职责/不变量 | `PaymentService.retry` 的契约 |
| Issue Decision | 用户对某类问题的裁决 | "retry_count 统计 attempts 是预期行为" |
| Finding Resolution | 修复历史(回归记忆) | "idempotency bug 已在 abc123 修复" |

核心安全规则:

- **Agent 不能写决策类 memory**(`expected/wont_fix/false_positive` 只能来自用户或 verified fix 流程);agent 写入的只有 `agent_summary` 级导航知识。
- **只有 `user_explicit`/`verified_fix` 可作为压制证据**,且压制必须经 Verifier 复核"旧结论对当前代码是否仍适用"——不适用就重新上报(可重新打开)。
- **偏置隔离**:Reviewer 看不到历史决策(避免"以前说过 false positive 就不检查"),只有 Verifier 同时拿到候选 + 历史决策 + 当前代码。
- Memory 以"证据而非指令"的形式注入,带固定防注入前言。
- 所有用户操作先写 `feedback_events`(append-only 审计),再派生 memory。

## 架构

```
Pi extension (/review-*)      pir CLI (bin)
        └──────────┬──────────────┘
                 src/app(用例层,命令语义唯一实现)
                        │
   ┌────────────────────┼──────────────────────┐
   core(supervisor/frontier/budget/convergence) │
   changes(git/diff)    findings(fingerprint/dedup)
   codemap(CodeGraph CLI 适配 / 降级)             memory(SQLite 五层)
                        │
        agents(会话工厂 — 唯一 import pi SDK 的层)
```

- Finding Loop:`explore → candidate → memory match → verify → expand frontier → repeat`,直到收敛/预算耗尽。
- Reviewer/Verifier 是互相独立的一次性只读会话(内置工具白名单 `read/grep/find/ls` + 自定义工具),产出必须经结构化工具(`record_candidate`/`submit_verdict`)收口。
- CodeMapProvider 按 codegraph 1.6.0 真实命令面适配(`query/callers/callees/impact/affected/files`,`--json`);未初始化/未安装时降级,**绝不自动 `codegraph init`**。

## 开发

```bash
npm run build        # tsc -> dist
npm test             # build + node --test(37 个用例,无需模型)
npm run typecheck
PIR_EVAL=1 node tests/eval/run-eval.js   # 评估(需要模型,见 tests/eval/)
```

- 测试不依赖模型:supervisor 外环、反馈闭环、压制契约等都用脚本化 FakeSessionFactory 驱动真实代码路径验证。
- `tests/eval/` 是评估脚手架(real bug / expected 抑制 / fixed 回归 / symbol 改名 / 影响面扩大等场景),指标含 repeated false positive 与 finding regression recall。
- 设计规格原文见 [docs/design.md](docs/design.md)。

## 边界(不做什么)

GitHub/GitLab/PR 评论、HTTP API、CI gate、merge gate、代码修复、findings 展示系统。CLI 只产出结构化 findings 与维护 memory;怎么展示、怎么拦截,由调用方决定。
