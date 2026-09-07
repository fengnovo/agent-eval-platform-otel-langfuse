import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { EvalTask, ScoreDetail, TraceEvent } from '@aep/shared';

const JudgeSchema = z.object({
  correctness: z.number().min(0).max(10),
  completeness: z.number().min(0).max(10),
  toolUse: z.number().min(0).max(10),
  efficiency: z.number().min(0).max(10),
  passed: z.boolean(),
  reason: z.string(),
});

/**
 * L3 LLM-as-a-Judge：只把任务约束、最终答案和可观察工具轨迹交给 Judge，
 * 并用 Zod 校验 JSON 输出。Judge 结果不能覆盖 L1 hard gate。
 */
export async function llmJudgeScorer(
  task: EvalTask,
  outcome: string,
  transcript: TraceEvent[],
  threshold: number,
): Promise<ScoreDetail> {
  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.JUDGE_MODEL ?? process.env.AGENT_MODEL ?? 'gpt-5-mini',
    temperature: 0,
    configuration: process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : undefined,
  });
  const compactTrace = transcript
    .filter((e) => ['tool_call', 'tool_result', 'error'].includes(e.type))
    .slice(-40);
  const prompt = `Task:\n${task.input}\n\nExpected constraints:\n${JSON.stringify(task.expected)}\n\nFinal outcome:\n${outcome}\n\nObservable trajectory (no hidden chain-of-thought):\n${JSON.stringify(compactTrace)}\n\nReturn ONLY JSON with keys correctness, completeness, toolUse, efficiency (0-10), passed, reason.`;
  const response = await model.invoke([
    new SystemMessage(
      'You are a strict evaluator for an AI coding agent. Judge only observable outputs and tool trajectory. Do not infer hidden reasoning.',
    ),
    new HumanMessage(prompt),
  ]);
  const raw =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  const parsed = JudgeSchema.parse(JSON.parse(jsonText));
  const score =
    (parsed.correctness +
      parsed.completeness +
      parsed.toolUse +
      parsed.efficiency) /
    40;
  return {
    name: 'llm_judge',
    layer: 'L3',
    score,
    passed: parsed.passed && score >= threshold,
    reason: parsed.reason,
  };
}
