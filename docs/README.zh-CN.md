# pir — 基于 Pi 的代码审查引擎(带仓库记忆)

[English](../README.md) · [LLM 部署指南](for-llm.md) · [设计规格](design.md)

`pir` 只做一件事:**尽可能准确地发现"本次变更引入的问题",并通过项目历史知识降低误报**。不做 GitHub/PR 评论、不做 CI 拦截、不做自动修复——输入结构化,输出结构化。

## 亮点

- **Reviewer → Verifier 双段闭环,从零实现。** 只读 reviewer 会话探索 diff,必须通过结构化工具(`record_candidate`)产出候选;每个候选再由独立的 verifier 会话复核,才能到达你面前。没有未经证实的 LLM 观点。
- **真正改变行为的仓库记忆。** 五层记忆(项目/功能/代码实体/问题裁决/修复历史)存 SQLite。你说一次"retry_count 统计的就是 attempts",同类问题不再上报——而且**每次都由 verifier 对照当前代码复核这条决策**,现实变了会重新打开。
- **按设计划分的信任边界。** Agent 永远写不了决策类记忆(`expected/wont-fix/false-positive` 只来自用户或 verified fix);reviewer 看不到历史决策(无偏置),只有 verifier 能看;记忆以"证据而非指令"注入,防提示注入。
- **审你手里的代码,不是你推上去的。** coderabbit-cli 式:客户端把本地状态打成 git bundle 送审——未 push 的提交、甚至**未提交的工作区**(`--uncommitted`)都能审,服务端不需要源仓库凭证。
- **机器优先的 CLI。** stdout 纯 JSON(`schemaVersion:1` 信封),进度走 stderr,退出码即契约(`0` 正常、`1` 存在 ≥ `--fail-on` 级别的 findings、`2` 用法错误、`3` 运行错误)。
- **单包三面。** 本地 CLI(`pir`)、Pi extension(`/review-find` 等 4 命令)、HTTPS 服务(`pir serve`)共享同一条命令路径。
- **精简核心。** 运行时依赖仅 Pi SDK + typebox;存储用 `node:sqlite`;可选 codegraph 提供符号级结构查询(缺失时优雅降级)。

## 架构

```
Pi extension (/review-*)        pir CLI ── 远端(--server)──┐
        └────────────┬─────────────────────┘               │
                  src/app(唯一命令路径:executor)           │
                     │                                    │
   ┌─────────────────┼───────────────────────────┐      HTTPS
   │ core: supervisor / frontier / budget        │   POST /v1/review
   │ changes: git / diff / 工作区快照            │◄────────┘
   │ findings: fingerprint / dedup               │ (客户端打包本地状态)
   │ codemap: codegraph 适配 / 降级              │
   │ memory: SQLite 五层 + 反馈闭环              │
   └─────────────────┬───────────────────────────┘
                     │
        agents:一次性内存会话
        (只读内置工具 + 结构化收口工具;
         reviewer 不见历史决策——verifier 才见)
```

核心不变量:

- `projectId = sha256(normalizedRemote + rootCommit)`——记忆跟随仓库,换机器/换路径不丢。**分支永不参与记忆 key**:不变量与历史决策是仓库级知识。
- 会话即弃(`SessionManager.inMemory()` + `dispose()`);持久的东西都在 SQLite,从不在聊天历史里。
- 服务端评审跑在一次性 `git worktree` 里;状态集中在 `PIR_STATE_ROOT/<projectId>/`。

## 安装

**Docker(推荐):**

```bash
docker pull ghcr.io/beiyanpiki/pir:main
sh docker/deploy.sh     # 交互式 QA 部署:问 token / API key / 端口 / TLS,自动验证
```

**本地 CLI:**

```bash
npm i -g .              # 得到 pir
pi install $(pwd)       # Pi extension:/review-* 命令
```

**模型接入(智谱官方 GLM):** pi 内置 `zai-coding-cn` provider 指向官方 coding 端点:

```jsonc
// ~/.pi/agent/auth.json(chmod 600)
{ "zai-coding-cn": { "type": "api_key", "key": "<你的 bigmodel key>" } }
```

`~/.pi/agent/settings.json` 设默认:`defaultProvider: "zai-coding-cn"`、
`defaultModel: "glm-5.3-flash"`、`defaultThinkingLevel: "low"`(GLM 只接受 low/high/max)。

## CLI 协议

**stdout 只输出结果**(`--json` 时为带 `schemaVersion: 1` 信封的纯 JSON);进度/日志一律 stderr。

```bash
pir find [--base <ref>] [--head <ref>] [--uncommitted] [--json]
         [--max-rounds N] [--max-tokens N]
         [--fail-on P0|P1|P2|P3|none] [--model <id>] [--no-sync-index]
pir memory status|bootstrap|refresh [--json] [--max-batches N]
pir feedback <id> <decision> [--note "..."]      # decision 见下
pir feedback <id> priority P0|P1|P2|P3
pir remember project|feature <k>|symbol <k> invariant|note|risk --text "..."
pir findings [list [--status <s>]] / pir findings show <id>
pir verify-fix <id>
pir repos add <git-url|路径> [--name <n>] | list | remove <n> [--purge]
pir serve [--host --port --cert --key --token]
pir version
```

全局:`--json`、`--cwd <path>`、`--quiet`;远端模式 `--server <url> --token <t> [--insecure]`。

- 决策集:`confirmed | expected | false-positive | accepted-risk | wont-fix | fixed | obsolete`
- 退出码:`0` 正常 | `1` 存在 ≥ `--fail-on` 级别的已报告 findings | `2` 用法错误 | `3` 运行错误
- 环境变量:`PIR_MEMORY_DB`(单库覆盖)、`PIR_STATE_IN_PROJECT=1`(状态进 `<repo>/.pir/`,docker exec 模式默认)、`PIR_STATE_ROOT`(服务端集中状态)、`PIR_REPOS_ROOT`(服务端仓库根)、`PIR_SERVER_TOKEN`/`PIR_TLS_CERT`/`PIR_TLS_KEY`(serve)、`PIR_KEEP_WORKTREE=1`(保留评审 worktree 调试)

## Docker 两种用法

```bash
# ① docker exec 直调:状态全部落 <repo>/.pir/
docker run --rm -v $PWD:/workspace ghcr.io/beiyanpiki/pir:main find --json

# ② HTTPS 服务(自签 TLS + Bearer):
docker run -d -p 8790:8790 -e PIR_SERVER_TOKEN=secret -e BIGMODEL_API_KEY=<key> \
  ghcr.io/beiyanpiki/pir:main serve
pir --server https://127.0.0.1:8790 --token secret --insecure find --uncommitted --json
```

服务协议:`GET /health`;`POST /v1/exec {"argv":[...]}` → `{code,output,log}`;`POST /v1/review`(**bundle 流**,客户端上传本地状态,服务端物化临时 worktree 评审,审未推送/未提交代码,无需源仓库凭证)。镜像内置 git/ripgrep/openssl(+可选 codegraph);密钥经环境变量注入,不进镜像不落 git。

## 仓库记忆(与普通 AI review 的区别)

| 层 | 内容 | 例子 |
|---|---|---|
| Project | 架构/职责/不变量 | "financial writes must be idempotent" |
| Feature | 垂直功能语义 | "payment-retry: 每次 attempt 前消耗配额" |
| Code Entity | symbol 级职责/不变量 | `PaymentService.retry` 的契约 |
| Issue Decision | 用户对某类问题的裁决 | "retry_count 统计 attempts 是预期行为" |
| Finding Resolution | 修复历史(回归记忆) | "idempotency bug 已在 abc123 修复" |

安全规则:只有 `user_explicit`/`verified_fix` 可作压制证据,且必须经 verifier 复核"旧结论对当前代码是否仍适用";压制不删除记录,影响面扩大时可重新打开;所有用户操作先写 `feedback_events`(append-only 审计)。

## 典型工作流

```bash
pir find --json --fail-on P1                       # 审查 HEAD^..HEAD
pir find --uncommitted --json                      # 审查未提交的工作区
pir feedback F-12 expected --note "intentional"    # 反馈写入长期记忆
pir find --json                                    # 同类问题不再打扰你
pir verify-fix F-13                                # 验证修复确实消除了触发路径
pir --server https://pir.svc:8790 find --uncommitted --json   # 远程审本地状态
```

## 开发

```bash
npm run build && npm test    # 48 个免模型测试(脚本化会话驱动整个引擎)
PIR_EVAL=1 node tests/eval/run-eval.js             # 评估套件(需要模型)
```

## 许可

[MIT](../LICENSE) © 2026 Xin Gao
