# 本版本新增内容

- 新增 `packages/telemetry`：统一初始化 OpenTelemetry NodeSDK。
- 新增 Langfuse v5 `LangfuseSpanProcessor` direct exporter。
- 新增 OTLP/HTTP exporter，可发送到 OpenTelemetry Collector。
- 新增 `otel/collector-debug.yaml`。
- 新增 `otel/collector-langfuse.yaml`，Collector 可转发到 Langfuse `/api/public/otel`。
- 新增 `docker-compose.otel-langfuse.yml`。
- Agent 增加 `agent.run`、`llm.agent`、`tool.*` Span。
- Evaluator 每个 Trial 建立独立 root trace，并增加 `evaluator.score` Span。
- PostgreSQL `eval_trials` 增加 `trace_id`，旧数据库可自动 `ALTER TABLE` 升级。
- Dashboard Trial 详情展示 OpenTelemetry traceId，并支持可选 Langfuse 跳转。
- 新增 `pnpm telemetry:smoke` 独立连通性测试。
- CLI/API 增加 OTel 初始化和优雅 shutdown/flush。
- 默认 `TELEMETRY_CAPTURE_CONTENT=0`，避免无意上传任务/代码/模型内容。
- CI 默认 `TELEMETRY_ENABLED=0`，避免 PR 测试污染 Langfuse 数据。

详细使用见 `docs/OPENTELEMETRY_LANGFUSE.md`。
