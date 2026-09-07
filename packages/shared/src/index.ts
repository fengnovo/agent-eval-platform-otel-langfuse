import { z } from 'zod';

/**
 * Agent 在一次 Trial 中产生的可观察事件。
 *
 * 这里刻意只保存模型调用、工具调用和结果等外部可观察信息，不保存
 * 模型隐藏的 chain-of-thought。Evaluator 的 L1/L2/L3 scorer 都以这份
 * transcript 作为输入，因此事件类型的变更会同时影响评分和 Dashboard。
 */
export const TraceEventSchema = z.object({
  ts: z.number(),
  type: z.enum([
    'agent_start',
    'llm_start',
    'llm_end',
    'tool_call',
    'tool_result',
    'error',
    'agent_end',
  ]),
  name: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** 单个评测题目的输入契约和期望结果。 */
export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.string(),
  fixture: z.string().optional(),
  timeoutMs: z.number().int().positive().default(120000),
  expected: z
    .object({
      requiredTools: z.array(z.string()).default([]),
      forbiddenTools: z.array(z.string()).default([]),
      requiredKeywords: z.array(z.string()).default([]),
      filesMustExist: z.array(z.string()).default([]),
      validationCommands: z.array(z.string()).default([]),
      referenceAnswer: z.string().optional(),
    })
    .default({
      requiredTools: [],
      forbiddenTools: [],
      requiredKeywords: [],
      filesMustExist: [],
      validationCommands: [],
    }),
  scoring: z
    .object({
      semanticThreshold: z.number().min(0).max(1).default(0.86),
      llmJudge: z.boolean().default(false),
      judgeThreshold: z.number().min(0).max(1).default(0.75),
    })
    .default({
      semanticThreshold: 0.86,
      llmJudge: false,
      judgeThreshold: 0.75,
    }),
});
export type EvalTask = z.infer<typeof TaskSchema>;

/** 一套评测题目，以及未显式指定 trial 数量时的默认重复次数。 */
export const SuiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  defaultTrials: z.number().int().positive().default(3),
  tasks: z.array(TaskSchema),
});
export type EvalSuite = z.infer<typeof SuiteSchema>;

/** 一个独立评分项的结果；hardGate 表示该项失败会直接阻断 Trial 通过。 */
export type ScoreDetail = {
  name: string;
  layer: 'L1' | 'L2' | 'L3';
  score: number;
  passed: boolean;
  hardGate?: boolean;
  reason: string;
};

/** 聚合后的 Trial 评分卡。 */
export type ScoreCard = {
  passed: boolean;
  totalScore: number;
  details: ScoreDetail[];
};

/** 用于比较 Agent 成本和稳定性的运行指标。 */
export type TrialMetrics = {
  latencyMs: number;
  llmCalls: number;
  toolCalls: number;
  commandFailures: number;
};

/** 一个 task 在某次重复执行中的完整结果。 */
export type TrialResult = {
  id: string;
  runId: string;
  taskId: string;
  trialIndex: number;
  input: string;
  outcome: string;
  workspace: string;
  /** OpenTelemetry trace id used to correlate this Trial with Langfuse. */
  traceId?: string;
  transcript: TraceEvent[];
  scoreCard: ScoreCard;
  metrics: TrialMetrics;
  error?: string;
};

/** 一整套 Suite 的聚合结果，也是 CLI、API 和 Dashboard 的摘要数据。 */
export type RunSummary = {
  runId: string;
  suiteId: string;
  startedAt: string;
  endedAt: string;
  trials: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
};
