# OpenTelemetry + Langfuse 接入说明

本版本在原 `agent-eval-platform` 基础上增加了完整的 OTel/Langfuse Trace 链路，并把每个 Trial 的 `traceId` 写入 PostgreSQL。

## 1. 最终 Trace 结构

```text
Evaluator Trial (root trace)
├─ Agent
│  ├─ LLM generation
│  ├─ Tool: read_file
│  ├─ LLM generation
│  ├─ Tool: write_file
│  ├─ LLM generation
│  ├─ Tool: run_command
│  └─ LLM generation
└─ Evaluator Score
```

每个 Trial 都是一个独立 Trace，因此 K Trials 不会挤在同一个 Trace 中。

```text
Task
├─ Trial 0 -> traceId A
├─ Trial 1 -> traceId B
└─ Trial 2 -> traceId C
```

数据库 `eval_trials.trace_id` 保存该关联，Dashboard 也会展示 traceId。

## 2. 模式 A：OTel SDK 直接写 Langfuse（先用这个验证）

`.env`：

```env
TELEMETRY_ENABLED=1
TELEMETRY_EXPORTER=langfuse
OTEL_SERVICE_NAME=agent-eval-platform

LANGFUSE_PUBLIC_KEY=pk-lf-xxx
LANGFUSE_SECRET_KEY=sk-lf-xxx
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development

# 本地学习可以打开；生产环境谨慎开启，因为会把任务、代码片段、模型输出发到可观测平台。
TELEMETRY_CAPTURE_CONTENT=1
```

执行：

```bash
pnpm install
pnpm telemetry:smoke
```

终端会输出：

```text
Telemetry smoke trace created. traceId=...
```

然后去 Langfuse 查看 `telemetry.smoke`。

再运行真实评测：

```bash
docker compose up -d
pnpm eval
```

Langfuse 中应该看到：

```text
evaluator.trial
├─ agent.run
│  ├─ llm.agent
│  ├─ tool.read_file
│  ├─ llm.agent
│  ├─ tool.write_file
│  ├─ tool.run_command
│  └─ ...
└─ evaluator.score
```

## 3. 模式 B：Agent -> OTel Collector -> Langfuse（生产式）

架构：

```text
Agent / Evaluator
      ↓
OpenTelemetry SDK
      ↓ OTLP/HTTP
OTel Collector
      ↓
Langfuse
```

先生成 Langfuse Basic Auth：

```bash
printf '%s' 'pk-lf-xxx:sk-lf-xxx' | base64
```

假设得到：

```text
YWJjOmRlZg==
```

`.env`：

```env
TELEMETRY_ENABLED=1
TELEMETRY_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces

LANGFUSE_OTEL_ENDPOINT=https://cloud.langfuse.com/api/public/otel
LANGFUSE_OTEL_AUTH=Basic YWJjOmRlZg==
```

启动 Postgres + Collector，并让 Collector 转发到 Langfuse：

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.otel-langfuse.yml \
  --profile otel \
  up -d
```

查看 Collector 日志：

```bash
docker compose --profile otel logs -f otel-collector
```

验证：

```bash
pnpm telemetry:smoke
pnpm eval
```

### 只验证 Collector，不发 Langfuse

```env
TELEMETRY_ENABLED=1
TELEMETRY_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
```

启动：

```bash
docker compose --profile otel up -d
pnpm telemetry:smoke
```

此时使用 `collector-debug.yaml`，Span 只打印到 Collector 日志。

## 4. 两种模式不要同时把同一个 Trace 写两次

本项目通过 `TELEMETRY_EXPORTER` 做互斥：

```text
langfuse -> LangfuseSpanProcessor 直接写 Langfuse
otlp     -> OTLP exporter 写 Collector
```

如果使用 `otlp` 且 Collector 已经转发到 Langfuse，就不要再使用 `langfuse` direct exporter，否则会出现重复 Trace。

## 5. 关键代码

### `packages/telemetry`

统一管理：

```text
OpenTelemetry NodeSDK
LangfuseSpanProcessor
OTLPTraceExporter
Span helper
flush / shutdown
```

业务包只依赖：

```ts
withTelemetrySpan(...)
```

而不是到处初始化 OTel SDK。

### `packages/evaluator`

每个 Trial 创建 root span：

```text
evaluator.trial
```

并将：

```text
run_id
trial_id
task_id
trial_index
```

写入 Langfuse metadata。

### `packages/agent`

创建：

```text
agent.run
llm.agent
tool.read_file
tool.write_file
tool.run_command
```

这些 Span 自动继承 Trial 的 OpenTelemetry context。

### `packages/db`

新增：

```sql
trace_id text
```

旧数据库启动时通过：

```sql
alter table eval_trials add column if not exists trace_id text;
```

自动升级。

## 6. Langfuse 输入输出与隐私

默认：

```env
TELEMETRY_CAPTURE_CONTENT=0
```

只记录：

```text
Trace/Span 名称
耗时
模型名称
Tool 名称
Trial ID
Task ID
成功/失败
Token usage（如果模型 SDK 返回）
```

开启：

```env
TELEMETRY_CAPTURE_CONTENT=1
```

才会将任务输入、Tool 输入输出、LLM 输入输出写入 `langfuse.observation.input/output`。

生产环境建议保持 `0`，除非已经确认代码、用户数据和密钥脱敏策略。

## 7. Dashboard 跳 Langfuse

可选设置：

```env
NEXT_PUBLIC_LANGFUSE_BASE_URL=https://cloud.langfuse.com
NEXT_PUBLIC_LANGFUSE_PROJECT_ID=你的Langfuse项目ID
```

Trial 详情会显示：

```text
OpenTelemetry traceId: ...
Open in Langfuse ↗
```

## 8. 推荐实际使用方式

本地第一次验证：

```text
TELEMETRY_EXPORTER=langfuse
```

生产/多后端：

```text
TELEMETRY_EXPORTER=otlp
      ↓
Collector
      ├─ Langfuse
      ├─ Tempo
      └─ 其他 OTel backend
```

核心职责仍然保持：

```text
Evaluator：Agent 做得对不对
OpenTelemetry：统一采集 Trace
Langfuse：Agent 到底怎么运行的
```
