# 项目架构与执行流程

本文档把代码中的模块边界、数据流和运行时控制流集中画出来。图中的模块名称与 workspace package 名称保持一致，便于从图直接跳到实现。

## 1. 总体架构

```mermaid
flowchart LR
    Suite["Suite JSON<br/>任务与评分规则"] --> CLI["CLI / API<br/>触发评测"]
    CLI --> Evaluator["@aep/evaluator<br/>runSuite / runOne"]
    Evaluator --> Workspace["独立 Trial Workspace<br/>fixture 副本"]
    Evaluator --> Agent["@aep/agent<br/>LangGraph Coding Agent"]
    Agent --> Tools["受限工具<br/>read_file / write_file / run_command"]
    Tools --> Workspace
    Agent --> Transcript["Observable Transcript<br/>LLM 与工具事件"]
    Evaluator --> Scorers["评分管线<br/>L1 Rule / L2 Semantic / L3 Judge"]
    Transcript --> Scorers
    Workspace --> Scorers
    Scorers --> ScoreCard["ScoreCard<br/>passed / totalScore / details"]
    Evaluator --> Result["TrialResult / RunSummary"]
    ScoreCard --> Result
    Result --> DB["@aep/db<br/>PostgreSQL"]
    DB --> API["apps/api<br/>Fastify REST"]
    API --> Web["apps/web<br/>Next.js Dashboard"]

    Evaluator -. spans .-> Telemetry["@aep/telemetry<br/>OpenTelemetry SDK"]
    Agent -. spans .-> Telemetry
    Telemetry -->|direct| Langfuse[Langfuse]
    Telemetry -->|OTLP/HTTP| Collector[OTel Collector]
    Collector --> Langfuse
```

### 模块职责

| 模块 | 责任 | 不负责什么 |
| --- | --- | --- |
| `packages/shared` | 用 Zod 定义 Suite/Task 和 TypeScript 结果类型 | 不执行 Agent，不连接数据库 |
| `packages/agent` | 在隔离目录中读写文件、执行 allowlist 命令，并记录轨迹 | 不决定任务是否通过 |
| `packages/evaluator` | 创建 Trial、运行 Agent、调用评分器、聚合指标 | 不提供 HTTP 接口 |
| `packages/evaluator/src/scorers` | 实现 L1 规则、L2 Embedding、L3 LLM Judge | 不负责保存结果 |
| `packages/db` | 初始化表结构并持久化 Run/Trial | 不执行评测逻辑 |
| `packages/telemetry` | 初始化 OTel、创建 Span、控制内容采集与 flush | 不改变评分结果 |
| `apps/api` | 暴露健康检查、Run 查询和启动评测的 REST API | 不直接实现评分算法 |
| `apps/web` | 展示 Run、Trial、Transcript、评分和 Langfuse 链接 | 不在浏览器执行 Agent |
| `scripts/run-eval.ts` | CLI 入口和 CI regression gate | 不提供长期 HTTP 服务 |

## 2. 一次 Suite 评测的时序

```mermaid
sequenceDiagram
    autonumber
    participant Trigger as CLI/API
    participant Eval as Evaluator
    participant DB as PostgreSQL
    participant Agent as LangGraph Agent
    participant WS as Trial Workspace
    participant OTel as OpenTelemetry

    Trigger->>Eval: loadSuite(JSON)
    Eval->>DB: saveRunStart(runId, suite)
    loop 每个 task 的每个 trial
        Eval->>OTel: start evaluator.trial (root trace)
        Eval->>WS: 删除并复制 fixture
        Eval->>Agent: runCodingAgent(task, workspace, transcript)
        Agent->>OTel: start agent.run
        loop 最多 12 个 graph step
            Agent->>OTel: start llm.agent
            Agent->>Agent: model.invoke(messages)
            alt 模型返回 tool call
                Agent->>OTel: start tool.*
                Agent->>WS: read/write/allowlisted command
                WS-->>Agent: tool result or error
                Agent->>Agent: append ToolMessage
            else 模型返回最终文本
                Agent-->>Eval: outcome
            end
        end
        Eval->>Eval: ruleScorers(L1)
        opt semantic scorer enabled
            Eval->>Eval: semanticScorer(L2)
        end
        opt LLM judge enabled
            Eval->>Eval: llmJudgeScorer(L3)
        end
        Eval->>DB: saveTrial(TrialResult)
        Eval->>OTel: end evaluator.trial
    end
    Eval->>DB: saveRunEnd(RunSummary)
    Eval-->>Trigger: summary
```

## 3. 评分与 Hard Gate 流程

```mermaid
flowchart TD
    Input["Task + outcome + transcript + workspace"] --> L1["L1 Rule Scorers"]
    L1 --> Required["工具/禁用工具/关键词"]
    L1 --> Files["文件存在性"]
    L1 --> Commands["验证命令退出码"]
    L1 --> Failures["Agent 命令失败次数"]
    Input --> L2{"ENABLE_SEMANTIC_SCORER=1<br/>且存在 referenceAnswer?"}
    L2 -->|是| Embedding["Embedding cosine similarity"]
    L2 -->|否| Skip2["跳过 L2"]
    Input --> L3{"task.scoring.llmJudge<br/>且 ENABLE_LLM_JUDGE != 0?"}
    L3 -->|是| Judge["LLM Judge JSON 评分"]
    L3 -->|否| Skip3["跳过 L3"]
    Required --> Aggregate[aggregateScore]
    Files --> Aggregate
    Commands --> Aggregate
    Failures --> Aggregate
    Embedding --> Aggregate
    Judge --> Aggregate
    Skip2 --> Aggregate
    Skip3 --> Aggregate
    Aggregate --> Hard{"是否存在失败的 hardGate?"}
    Hard -->|是| Fail["Trial failed"]
    Hard -->|否| Threshold{"平均分 >= 0.7 且软规则通过?"}
    Threshold -->|是| Pass["Trial passed"]
    Threshold -->|否| Fail
```

`hardGate` 是不可被 L2/L3 高分覆盖的硬约束。Trial 超时或 Agent 抛错时，Evaluator 还会插入一个失败的 `trial_error` hard gate。

## 4. 可观测性分层

```mermaid
flowchart TB
    Root["evaluator.trial<br/>traceId 写入 eval_trials.trace_id"]
    Root --> Run["agent.run"]
    Run --> LLM["llm.agent<br/>模型与 token usage"]
    Run --> Tool1["tool.read_file"]
    Run --> Tool2["tool.write_file"]
    Run --> Tool3["tool.run_command"]
    Root --> Score["evaluator.score"]
    SDK["packages/telemetry"] --> Root
    SDK --> Export{"TELEMETRY_EXPORTER"}
    Export -->|langfuse| Direct["LangfuseSpanProcessor"]
    Export -->|otlp| OTLP["OTLPTraceExporter"]
    OTLP --> Collector["OpenTelemetry Collector"]
    Direct --> Backend["Langfuse / 其他后端"]
    Collector --> Backend
```

默认 `TELEMETRY_CAPTURE_CONTENT=0`，因此 span 仍保留名称、耗时、状态、metadata 和 token usage，但不会上传任务、代码片段或模型内容。打开内容采集前，应先确认脱敏和数据保留策略。

## 5. 安全边界与故障边界

- `agent` 的文件工具通过 `assertInsideWorkspace` 拒绝逃逸 Trial 目录的路径。
- `run_command` 只接受固定前缀 allowlist，并在 Trial workspace 中执行。
- 每个 Trial 先清空并复制 fixture，避免不同 Trial 共享文件修改。
- Agent、验证命令和 Trial 都有超时；子进程超时会被终止，Trial 超时会进入失败评分。
- OTel/Langfuse 是旁路能力，初始化失败不会改变核心评测模型，但 flush/shutdown 会在 CLI/API 退出时执行。
- 当前命令执行仍是本机 `child_process`，不等同于生产级沙箱；公网或不可信输入场景应迁移到 Docker、gVisor 或 Firecracker。
