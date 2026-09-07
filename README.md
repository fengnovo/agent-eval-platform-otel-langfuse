# Agent Evaluation Platform (TypeScript + LangGraph)

这是一个可运行的 Agent Eval 参考项目，针对 Coding Agent 实现：**Task/Suite → K 次 Trial → 完整 Transcript → Outcome → L1/L2/L3 Scorer → 聚合指标 → PostgreSQL → Web Dashboard → CI Regression Gate**。

## 1. 架构

完整的模块架构、Trial 时序、评分流程和 OTel 导出分支见：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

```text
Suite / Task
   ↓
Trial Runner (K 次, 并发控制, 每次独立 workspace)
   ↓
LangGraph Coding Agent
   ├─ read_file
   ├─ write_file
   └─ run_command
   ↓
Observable Transcript
   ├─ llm_start / llm_end
   ├─ tool_call / tool_result
   └─ error
   ↓
Scorer Pipeline
   ├─ L1 Rule: 工具、文件、命令、测试、Hard Gate
   ├─ L2 Semantic: Embedding cosine similarity (可选)
   └─ L3 Judge: LLM-as-a-Judge (可选)
   ↓
ScoreCard
   ↓
PostgreSQL
   ↓
Next.js Dashboard / GitHub Actions Gate
```

## 2. 不只看最终答案

- 每个 Trial 有隔离 workspace，避免 K 次运行互相污染。
- Transcript 记录可观察轨迹，不记录/依赖模型隐藏 Chain-of-Thought。
- Build/Test/File existence 等属于 **Hard Gate**；LLM Judge 给高分也不能覆盖失败。
- 可重复 Trial，最终统计 pass rate / avg score / P95 latency。
- GitHub Actions 可以在 PR 上以阈值阻止 Agent 回归。
- `run_command` 有 cwd 限制和命令 allowlist；真正多租户生产环境应进一步放进 Docker/Firecracker 沙箱。

## 3. 启动

要求 Node.js 22+、pnpm 10+、Docker。

```bash
cp .env.example .env
# 填 OPENAI_API_KEY / OPENAI_BASE_URL / AGENT_MODEL / JUDGE_MODEL

docker compose up -d
pnpm install
pnpm typecheck
pnpm eval
```

如果你使用百炼 OpenAI-compatible endpoint，只要把 `.env` 的 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和模型名替换掉即可。

本地 PostgreSQL 映射到 `127.0.0.1:5433`，避免和机器上已有的 5432 冲突。

启动界面：

```bash
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:3001

## 4. 评估数据集

`suites/coding-agent.json` 是第一套试卷。当前题目会复制 `fixtures/typescript-buggy` 到独立 trial workspace，然后要求 Agent 修复 Bug，并强制验证：

```text
required tool: read_file
required tool: write_file
required tool: run_command
hard gate: pnpm typecheck == 0
hard gate: pnpm test == 0
L3: LLM Judge >= 0.75
```

增加题目只需要继续追加 JSON：

```json
{
  "id": "task-id",
  "name": "Task name",
  "fixture": "fixtures/your-project",
  "input": "具体任务",
  "expected": {
    "requiredTools": ["read_file", "write_file", "run_command"],
    "filesMustExist": ["src/index.ts"],
    "validationCommands": ["pnpm typecheck", "pnpm test"]
  },
  "scoring": { "llmJudge": true, "judgeThreshold": 0.8 }
}
```

## 5. 核心目录

```text
apps/
  api/                  Fastify API
  web/                  Next.js dashboard
packages/
  agent/                LangGraph coding agent + tools + trace
  evaluator/            trial runner + L1/L2/L3 scorers + aggregate
  db/                   PostgreSQL persistence
  shared/               shared schemas/types
fixtures/                每个任务的初始工程快照
suites/                  eval datasets
scripts/run-eval.ts      CLI 入口
.github/workflows/       PR regression gate
```

## 6. 生产环境下一步

1. 将 `run_command` 从本机 child_process 替换为 Docker / gVisor / Firecracker sandbox。
2. 接 Langfuse / LangSmith / OpenTelemetry，把 trace 同步到专业 observability 平台。
3. 加 Dataset version / Agent version / Prompt version / Model version，支持同一 Suite 的 A/B 对比。
4. 用 Wilson interval 或 bootstrap 给 pass rate/score 置信区间。
5. 为 judge 加 calibration set，避免模型升级导致评分漂移。
6. 从线上失败 trace 自动沉淀 regression task。
7. 将 CI Gate 从全局 80% 扩展为：核心任务 100%、普通任务 90%、成本/P95 不得退化超过阈值。

## 7. 安全说明

该仓库用于本地/内部参考。虽然工具限制在 trial workspace 且 `run_command` 有 allowlist，但它仍使用本机进程。不要把不可信用户输入直接暴露给此执行器。面向公网时必须使用真正隔离的执行沙箱并设置 CPU/内存/网络/时间/文件系统限制。

---

## OpenTelemetry + Langfuse（新增）

本版本已增加完整 Trace 接入：

```text
Trial(root trace)
├─ agent.run
│  ├─ llm.agent
│  ├─ tool.read_file
│  ├─ tool.write_file
│  └─ tool.run_command
└─ evaluator.score
```

支持两种出口：

```text
TELEMETRY_EXPORTER=langfuse
Agent -> OpenTelemetry -> LangfuseSpanProcessor -> Langfuse

TELEMETRY_EXPORTER=otlp
Agent -> OpenTelemetry -> OTLP Collector -> Langfuse/Tempo/其他后端
```

快速验证：

```bash
cp .env.example .env
# 填入 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
# TELEMETRY_ENABLED=1
# TELEMETRY_EXPORTER=langfuse
pnpm install
pnpm telemetry:smoke
pnpm eval
```

详细配置见：[`docs/OPENTELEMETRY_LANGFUSE.md`](docs/OPENTELEMETRY_LANGFUSE.md)。
