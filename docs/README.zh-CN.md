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

**npx —— 直接从 GitHub 安装,不经过 npm registry:**

```bash
npx -y github:beiyanpiki/pir find --json
# 或者常驻安装:                    (需要 Node >= 22.5;git 安装会自动构建)
npm i -g github:beiyanpiki/pir     # 得到 pir
```

CI 每次推送都会构建并对这个包做冒烟安装验证([ci.yml](../.github/workflows/ci.yml)
的 `package` job),产物作为 workflow artifact 上传;打 `v*` tag 时,`pir-<版本>.tgz`
会附加到 GitHub Release,供固定版本安装使用。

首次在终端交互运行时,`pir` 会启动一个简短的配置向导,把配置写进
`~/.pir/config.json`(chmod 600):**本地模式**(默认,在当前仓库用本机
pi 凭证评审)或**远程模式**(所有命令转发给 `pir serve` 实例;`find`
以 git bundle 上送本地状态,未推送/未提交代码都能评审)。非交互环境自动
退回本地默认并提示一行。之后可管理:

```bash
pir config show                                   # 查看生效配置(token 打码)
pir config set mode remote                        # 以及 server.url / server.token / server.insecure
pir config wizard                                 # 重跑配置向导
pir --local find --json                           # 单次覆盖,两个方向都行
pir --server https://pir.svc:8790 --token T --insecure find --uncommitted --json
```

**给编码 agent 装 skill:**`pir skill install` 把本仓库的
`skills/pir/SKILL.md` 复制到 `~/.agents/skills/pir/`,教会 agent 何时、
如何调用这个 CLI(安装、双模式、JSON 协议、反馈闭环、排障)。其他
agent 框架可用 `pir skill print` 直接输出内容。

**Docker(推荐用于服务端):**

```bash
docker pull ghcr.io/beiyanpiki/pir:main
sh docker/deploy.sh     # 交互式 QA 部署:问 token / provider+模型+key / 端口 / TLS,自动验证
```

**从源码(扩展 + CLI):**

```bash
npm i -g .              # 得到 pir
pi install $(pwd)       # Pi extension:/review-* 命令
```

**模型接入(任意 pi 支持的 provider):** anthropic、openai、google、
deepseek、moonshotai、zai-coding-cn、minimax、openrouter、xai、groq……
pi 目录里的 provider 都可用。先浏览目录:

```bash
pir models                      # 已配置凭证的模型
pir models --all glm            # 全量目录,子串过滤
pir models --ids --provider deepseek   # 每行一个 provider/model(脚本友好)
```

凭证放 `~/.pi/agent/auth.json`(chmod 600),每个 provider 一条:

```jsonc
{
  "zai-coding-cn": { "type": "api_key", "key": "<你的 bigmodel key>" },
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

`~/.pi/agent/settings.json` 设默认(`defaultProvider`/`defaultModel`/
`defaultThinkingLevel`)。review/verify 会话的模型优先级:`--model
<provider>/<model>`(支持模糊 id)> `PIR_MODEL` 环境变量 > pi settings。
Docker 下按 provider 注入凭证:`-e PI_API_KEY__deepseek=sk-...`(或整份
`PI_AUTH_JSON`),默认模型用 `PI_DEFAULT_PROVIDER`/`PI_DEFAULT_MODEL`。

## CLI 协议

**stdout 只输出结果**(`--json` 时为带 `schemaVersion: 1` 信封的纯 JSON);进度/日志一律 stderr。

```bash
pir find [--base <ref>] [--head <ref>] [--uncommitted] [--json]
         [--max-rounds N] [--max-tokens N]
         [--fail-on P0|P1|P2|P3|none] [--model <id>] [--no-sync-index]
pir memory status|bootstrap|refresh [--json] [--max-batches N] [--model <id>]
pir feedback <id> <decision> [--note "..."]      # decision 见下
pir feedback <id> priority P0|P1|P2|P3
pir remember project|feature <k>|symbol <k> invariant|note|risk --text "..."
pir findings [list [--status <s>]] / pir findings show <id>
pir models [search] [--all] [--ids] [--provider <p>] [--json]
pir verify-fix <id> [--model <id>]
pir repos add <git-url|路径> [--name <n>] | list | remove <n> [--purge]
pir serve [--host --port --cert --key --token]
pir config [show|wizard|set|reset]      # 管理 ~/.pir/config.json(客户端配置)
pir skill [path|install|print]          # 定位 / 安装 LLM skill
pir version
```

全局:`--json`、`--cwd <path>`、`--quiet`;远端模式 `--server <url> --token <t> [--insecure]`(`pir --server ... models` 列的是**服务端**可用的模型),`--local` 单次强制本地。模式解析优先级:`--server` > `--local` > `PIR_SERVER_URL` > `PIR_MODE` > `~/.pir/config.json`;`serve`/`config`/`skill`/`version` 始终本地执行。

- `--model <id>`:`<provider>/<model>` 或模糊 id(`pir models` 查目录);缺省时依次取 `PIR_MODEL` 环境变量、`~/.pir/config.json` 的 `model`、pi settings 默认
- 决策集:`confirmed | expected | false-positive | accepted-risk | wont-fix | fixed | obsolete`
- 退出码:`0` 正常 | `1` 存在 ≥ `--fail-on` 级别的已报告 findings | `2` 用法错误 | `3` 运行错误
- 环境变量:`PIR_MODEL`(默认模型覆盖)、`PIR_MEMORY_DB`(单库覆盖)、`PIR_STATE_IN_PROJECT=1`(状态进 `<repo>/.pir/`,docker exec 模式默认)、`PIR_STATE_ROOT`(服务端集中状态)、`PIR_REPOS_ROOT`(服务端仓库根)、`PIR_SERVER_TOKEN`/`PIR_TLS_CERT`/`PIR_TLS_KEY`(serve)、`PIR_KEEP_WORKTREE=1`(保留评审 worktree 调试)、`PIR_SERVER_URL`/`PIR_MODE`(远程模式)、`PIR_CONFIG_DIR`(配置目录,默认 `~/.pir`)、`PIR_NO_WIZARD=1`(禁用首次向导)

## Docker 两种用法

```bash
# ① docker exec 直调:状态全部落 <repo>/.pir/,凭证按 provider 注入
docker run --rm -v $PWD:/workspace \
  -e PI_API_KEY__zai-coding-cn=<key> \
  ghcr.io/beiyanpiki/pir:main find --json

# ② HTTPS 服务(自签 TLS + Bearer):compose 见 docker-compose.yml
docker run -d -p 8790:8790 -e PIR_SERVER_TOKEN=secret \
  -e PI_AUTH_JSON='{"deepseek":{"type":"api_key","key":"<key>"}}' \
  -e PI_DEFAULT_PROVIDER=deepseek -e PI_DEFAULT_MODEL=deepseek-v4-pro \
  ghcr.io/beiyanpiki/pir:main serve
pir --server https://127.0.0.1:8790 --token secret --insecure find --uncommitted --json
```

模型相关环境变量:`PI_AUTH_JSON`(整份 auth map)、`PI_API_KEY__<provider>`(单 provider key,适合 docker run/exec)、`PI_DEFAULT_PROVIDER`/`PI_DEFAULT_MODEL`/`PI_DEFAULT_THINKING`(覆盖默认模型;不设则沿用镜像内置默认 zai-coding-cn/glm-5.3-flash)。容器内可用 `docker run --rm <image> models --all` 浏览目录。

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
npm run build && npm test    # 50 个免模型测试(脚本化会话驱动整个引擎)
PIR_EVAL=1 node tests/eval/run-eval.js             # 评估套件(需要模型)
```

## 许可

[MIT](../LICENSE) © 2026 Xin Gao
