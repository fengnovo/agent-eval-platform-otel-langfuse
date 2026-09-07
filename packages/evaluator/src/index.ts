import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCodingAgent } from '@aep/agent';
import {
  SuiteSchema,
  type EvalSuite,
  type EvalTask,
  type RunSummary,
  type ScoreCard,
  type ScoreDetail,
  type TrialResult,
  type TraceEvent,
} from '@aep/shared';
import {
  setSpanOutput,
  setTraceMetadata,
  withTelemetrySpan,
} from '@aep/telemetry';
import { ruleScorers } from './scorers/rule.js';
import { semanticScorer } from './scorers/semantic.js';
import { llmJudgeScorer } from './scorers/judge.js';

export type PersistAdapter = {
  saveRunStart?: (runId: string, suite: EvalSuite) => Promise<void>;
  saveTrial?: (trial: TrialResult) => Promise<void>;
  saveRunEnd?: (summary: RunSummary) => Promise<void>;
};

/** 从磁盘读取并用 shared schema 校验 Suite，避免脏配置进入执行阶段。 */
export async function loadSuite(filePath: string): Promise<EvalSuite> {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  return SuiteSchema.parse(raw);
}

/** 清理并复制 fixture，保证每个 Trial 都从相同初始工程开始。 */
async function copyFixture(fixture: string | undefined, destination: string) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  if (fixture)
    await fs.cp(path.resolve(fixture), destination, { recursive: true });
}

/**
 * 汇总所有评分项。hard gate 先单独判断，防止软评分或 LLM Judge 的高分
 * 覆盖编译、测试、文件存在性等不可妥协的失败。
 */
function aggregateScore(details: ScoreDetail[]): ScoreCard {
  const hardGateFailed = details.some((d) => d.hardGate && !d.passed);
  const totalScore = details.length
    ? details.reduce((s, d) => s + d.score, 0) / details.length
    : 0;
  const softPassed =
    details.every((d) => d.passed || !d.hardGate) && totalScore >= 0.7;
  return { passed: !hardGateFailed && softPassed, totalScore, details };
}

/** 按开关执行 L1/L2/L3 评分，并在 evaluator.score span 中记录结果。 */
async function evaluate(
  task: EvalTask,
  outcome: string,
  transcript: TraceEvent[],
  workspace: string,
) {
  return withTelemetrySpan(
    'evaluator.score',
    {
      type: 'evaluator',
      input: { taskId: task.id, outcome },
      metadata: { task_id: task.id },
    },
    async (span) => {
      const details = await ruleScorers(task, transcript, outcome, workspace);
      if (
        process.env.ENABLE_SEMANTIC_SCORER === '1' &&
        task.expected.referenceAnswer
      ) {
        details.push(
          await semanticScorer(
            outcome,
            task.expected.referenceAnswer,
            task.scoring.semanticThreshold,
          ),
        );
      }
      if (process.env.ENABLE_LLM_JUDGE !== '0' && task.scoring.llmJudge) {
        details.push(
          await llmJudgeScorer(
            task,
            outcome,
            transcript,
            task.scoring.judgeThreshold,
          ),
        );
      }
      const card = aggregateScore(details);
      setSpanOutput(span, card);
      return card;
    },
  );
}

/**
 * 执行一个 Trial 的完整生命周期：建 trace、准备 workspace、运行 Agent、
 * 评分、统计指标。该函数是单个 task/trial 的核心控制边界。
 */
async function runOne(
  runId: string,
  task: EvalTask,
  trialIndex: number,
  rootDir: string,
): Promise<TrialResult> {
  const trialId = crypto.randomUUID();
  const workspace = path.join(rootDir, runId, task.id, String(trialIndex));

  // 每个 Trial 是一个独立 OpenTelemetry root trace。Agent、LLM、Tool、Scorer
  // 都会在当前 active context 下自动成为它的子 Span。
  return withTelemetrySpan(
    'evaluator.trial',
    {
      type: 'evaluator',
      input: { taskId: task.id, task: task.input, trialIndex },
      metadata: {
        run_id: runId,
        trial_id: trialId,
        task_id: task.id,
        trial_index: trialIndex,
      },
    },
    async (span) => {
      const rawTraceId = span.spanContext().traceId;
      const traceId = /^0+$/.test(rawTraceId) ? undefined : rawTraceId;
      setTraceMetadata(span, {
        run_id: runId,
        trial_id: trialId,
        task_id: task.id,
        trial_index: trialIndex,
      });

      await copyFixture(task.fixture, workspace);
      const transcript: TraceEvent[] = [];
      const started = Date.now();
      let outcome = '';
      let error: string | undefined;

      try {
        outcome = await Promise.race([
          runCodingAgent({
            task: task.input,
            workspaceRoot: workspace,
            transcript,
            timeoutMs: task.timeoutMs,
          }),
          new Promise<string>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`Trial timeout after ${task.timeoutMs}ms`)),
              task.timeoutMs,
            ),
          ),
        ]);
      } catch (e) {
        error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        transcript.push({
          ts: Date.now(),
          type: 'error',
          name: 'trial',
          output: error,
        });
      }

      const scoreCard = await evaluate(task, outcome, transcript, workspace);
      if (error) {
        scoreCard.details.unshift({
          name: 'trial_error',
          layer: 'L1',
          score: 0,
          passed: false,
          hardGate: true,
          reason: error,
        });
        scoreCard.passed = false;
        scoreCard.totalScore =
          scoreCard.details.reduce((s, d) => s + d.score, 0) /
          scoreCard.details.length;
      }

      const result: TrialResult = {
        id: trialId,
        runId,
        taskId: task.id,
        trialIndex,
        input: task.input,
        outcome,
        workspace,
        traceId,
        transcript,
        scoreCard,
        metrics: {
          latencyMs: Date.now() - started,
          llmCalls: transcript.filter((e) => e.type === 'llm_end').length,
          toolCalls: transcript.filter((e) => e.type === 'tool_call').length,
          commandFailures: transcript.filter(
            (e) =>
              e.type === 'tool_result' &&
              e.name === 'run_command' &&
              Number(e.meta?.exitCode ?? 0) !== 0,
          ).length,
        },
        error,
      };

      span.setAttribute('eval.passed', result.scoreCard.passed);
      span.setAttribute('eval.total_score', result.scoreCard.totalScore);
      span.setAttribute('eval.latency_ms', result.metrics.latencyMs);
      span.setAttribute('eval.tool_calls', result.metrics.toolCalls);
      span.setAttribute('eval.llm_calls', result.metrics.llmCalls);
      setSpanOutput(span, {
        passed: result.scoreCard.passed,
        score: result.scoreCard.totalScore,
        outcome: result.outcome,
      });
      return result;
    },
  );
}

/** 计算 nearest-rank 风格的百分位延迟，空输入返回 0。 */
function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
}

export async function runSuite(
  suite: EvalSuite,
  options?: {
    trials?: number;
    concurrency?: number;
    runRoot?: string;
    persist?: PersistAdapter;
  },
) {
  // 使用共享 cursor 的 worker 池控制并发；每个 job 仍拥有独立 workspace。
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const trialsPerTask = options?.trials ?? suite.defaultTrials;
  const concurrency = Math.max(1, options?.concurrency ?? 2);
  const root = path.resolve(options?.runRoot ?? '.eval-runs');
  await options?.persist?.saveRunStart?.(runId, suite);

  const jobs = suite.tasks.flatMap((task) =>
    Array.from({ length: trialsPerTask }, (_, i) => ({ task, i })),
  );
  const results: TrialResult[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, jobs.length) },
    async () => {
      while (true) {
        const current = cursor++;
        const job = jobs[current];
        if (!job) break;
        const result = await runOne(runId, job.task, job.i, root);
        results.push(result);
        await options?.persist?.saveTrial?.(result);
      }
    },
  );
  await Promise.all(workers);

  const passed = results.filter((r) => r.scoreCard.passed).length;
  const latencies = results.map((r) => r.metrics.latencyMs);
  const summary: RunSummary = {
    runId,
    suiteId: suite.id,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    trials: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    avgScore: results.length
      ? results.reduce((s, r) => s + r.scoreCard.totalScore, 0) / results.length
      : 0,
    avgLatencyMs: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
    p95LatencyMs: percentile(latencies, 0.95),
  };
  await options?.persist?.saveRunEnd?.(summary);
  return { summary, results };
}
