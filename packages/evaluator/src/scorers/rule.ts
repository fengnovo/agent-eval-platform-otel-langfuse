import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { EvalTask, ScoreDetail, TraceEvent } from '@aep/shared';

/** 执行一条验证命令；输出只保留尾部，避免失败日志撑爆评分结果。 */
function run(command: string, cwd: string, timeoutMs = 120000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, CI: '1' },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`validation timeout: ${command}`));
      }, timeoutMs);
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stderr += String(d)));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? -1,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
        });
      });
    },
  );
}

/**
 * L1 确定性评分器：验证工具使用、文件产物、命令结果和关键字。
 * 这些规则不依赖模型，因此适合充当 hard gate；若没有任何显式规则，
 * 则退化为“Agent 必须返回非空结果”的最小检查。
 */
export async function ruleScorers(
  task: EvalTask,
  transcript: TraceEvent[],
  outcome: string,
  workspace: string,
): Promise<ScoreDetail[]> {
  const details: ScoreDetail[] = [];
  const toolCalls = transcript
    .filter((e) => e.type === 'tool_call')
    .map((e) => e.name)
    .filter(Boolean) as string[];

  for (const required of task.expected.requiredTools) {
    const passed = toolCalls.includes(required);
    details.push({
      name: `required_tool:${required}`,
      layer: 'L1',
      score: passed ? 1 : 0,
      passed,
      hardGate: true,
      reason: passed
        ? `Used ${required}`
        : `Required tool was not used: ${required}`,
    });
  }
  for (const forbidden of task.expected.forbiddenTools) {
    const passed = !toolCalls.includes(forbidden);
    details.push({
      name: `forbidden_tool:${forbidden}`,
      layer: 'L1',
      score: passed ? 1 : 0,
      passed,
      hardGate: true,
      reason: passed
        ? `Did not use ${forbidden}`
        : `Forbidden tool was used: ${forbidden}`,
    });
  }
  for (const keyword of task.expected.requiredKeywords) {
    const passed = outcome.toLowerCase().includes(keyword.toLowerCase());
    details.push({
      name: `keyword:${keyword}`,
      layer: 'L1',
      score: passed ? 1 : 0,
      passed,
      reason: passed
        ? `Outcome contains ${keyword}`
        : `Outcome misses required keyword: ${keyword}`,
    });
  }
  for (const file of task.expected.filesMustExist) {
    let passed = false;
    try {
      await fs.access(path.resolve(workspace, file));
      passed = true;
    } catch {
      passed = false;
    }
    details.push({
      name: `file_exists:${file}`,
      layer: 'L1',
      score: passed ? 1 : 0,
      passed,
      hardGate: true,
      reason: passed
        ? `File exists: ${file}`
        : `Missing expected file: ${file}`,
    });
  }
  for (const command of task.expected.validationCommands) {
    try {
      const result = await run(command, workspace, task.timeoutMs);
      const passed = result.code === 0;
      details.push({
        name: `command:${command}`,
        layer: 'L1',
        score: passed ? 1 : 0,
        passed,
        hardGate: true,
        reason: passed
          ? `Validation passed: ${command}`
          : `Validation failed (${result.code}): ${command}\n${result.stderr || result.stdout}`,
      });
    } catch (e) {
      details.push({
        name: `command:${command}`,
        layer: 'L1',
        score: 0,
        passed: false,
        hardGate: true,
        reason: String(e),
      });
    }
  }
  const commandFailures = transcript.filter(
    (e) =>
      e.type === 'tool_result' &&
      e.name === 'run_command' &&
      Number(e.meta?.exitCode ?? 0) !== 0,
  ).length;
  if (commandFailures > 0) {
    details.push({
      name: 'agent_command_failures',
      layer: 'L1',
      score: 0,
      passed: false,
      reason: `${commandFailures} command(s) failed during the agent trajectory`,
    });
  }
  if (details.length === 0) {
    details.push({
      name: 'non_empty_outcome',
      layer: 'L1',
      score: outcome.trim() ? 1 : 0,
      passed: Boolean(outcome.trim()),
      reason: outcome.trim() ? 'Outcome is non-empty' : 'Outcome is empty',
    });
  }
  return details;
}
