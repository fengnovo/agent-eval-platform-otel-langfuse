import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod/v4';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TraceEvent } from '@aep/shared';
import {
  setGenerationUsage,
  setSpanOutput,
  setTraceMetadata,
  withTelemetrySpan,
} from '@aep/telemetry';

export type AgentRunInput = {
  task: string;
  workspaceRoot: string;
  transcript: TraceEvent[];
  timeoutMs?: number;
};

/**
 * 将用户提供的相对路径解析到 Trial workspace 内。
 * 这是文件工具的第一道安全边界：即使输入包含 `..`，解析后的路径也
 * 必须仍然位于 root 目录下，否则拒绝操作。
 */
function assertInsideWorkspace(root: string, userPath: string) {
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }
  return resolved;
}

/** 为 transcript 事件统一补充毫秒级时间戳。 */
function push(trace: TraceEvent[], event: Omit<TraceEvent, 'ts'>) {
  trace.push({ ts: Date.now(), ...event });
}

/**
 * 执行 Agent 允许的 shell 命令，并限制工作目录、输出大小和执行时间。
 * allowlist 不是生产沙箱；它只降低本地参考项目中误执行任意命令的风险。
 */
function runProcess(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{
    code: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>((resolve, reject) => {
    const allowed = [
      'pnpm ',
      'npm ',
      'npx tsc',
      'node ',
      'git diff',
      'git status',
    ];
    if (
      !allowed.some(
        (prefix) => command === prefix.trim() || command.startsWith(prefix),
      )
    ) {
      reject(new Error(`Command is not allowlisted: ${command}`));
      return;
    }
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timeout after ${timeoutMs}ms: ${command}`));
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
        stdout: stdout.slice(-12000),
        stderr: stderr.slice(-12000),
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * 运行一个 LangGraph coding agent。
 *
 * 图只有两个业务节点：agent 负责调用模型，tools 负责顺序执行模型
 * 返回的工具调用。每轮结果都会写入 transcript，并通过 telemetry span
 * 与当前 Trial 的 root trace 自动关联。
 */
export async function runCodingAgent(input: AgentRunInput): Promise<string> {
  const { workspaceRoot, transcript } = input;
  const commandTimeout = Math.min(input.timeoutMs ?? 120000, 120000);

  // 每个工具先用 Zod 校验模型生成的参数，再进入文件系统或子进程。
  const readFileSchema = z.object({ filePath: z.string() });
  const writeFileSchema = z.object({
    filePath: z.string(),
    content: z.string(),
  });
  const runCommandSchema = z.object({ command: z.string() });

  // 读取工具只允许访问当前 Trial workspace，并截断超长内容以控制上下文和观测数据体积。
  const readFile = tool<typeof readFileSchema, z.infer<typeof readFileSchema>>(
    async (toolInput) => {
      const { filePath } = readFileSchema.parse(toolInput);
      return withTelemetrySpan(
        'tool.read_file',
        {
          type: 'tool',
          input: { filePath },
          metadata: { tool_name: 'read_file' },
        },
        async (span) => {
          const started = Date.now();
          push(transcript, {
            type: 'tool_call',
            name: 'read_file',
            input: { filePath },
          });
          try {
            const absolute = assertInsideWorkspace(workspaceRoot, filePath);
            const content = await fs.readFile(absolute, 'utf8');
            const out = content.slice(0, 30000);
            push(transcript, {
              type: 'tool_result',
              name: 'read_file',
              output: out,
              durationMs: Date.now() - started,
            });
            setSpanOutput(span, out);
            return out;
          } catch (e) {
            push(transcript, {
              type: 'error',
              name: 'read_file',
              output: String(e),
              durationMs: Date.now() - started,
            });
            throw e;
          }
        },
      );
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the isolated task workspace.',
      schema: readFileSchema,
    },
  );

  // 写入工具会自动创建父目录，但不能写出 workspace 边界。
  const writeFile = tool<
    typeof writeFileSchema,
    z.infer<typeof writeFileSchema>
  >(
    async (toolInput) => {
      const { filePath, content } = writeFileSchema.parse(toolInput);
      return withTelemetrySpan(
        'tool.write_file',
        {
          type: 'tool',
          input: { filePath, bytes: content.length },
          metadata: { tool_name: 'write_file' },
        },
        async (span) => {
          const started = Date.now();
          push(transcript, {
            type: 'tool_call',
            name: 'write_file',
            input: { filePath, bytes: content.length },
          });
          try {
            const absolute = assertInsideWorkspace(workspaceRoot, filePath);
            await fs.mkdir(path.dirname(absolute), { recursive: true });
            await fs.writeFile(absolute, content, 'utf8');
            const out = `Wrote ${filePath} (${content.length} chars)`;
            push(transcript, {
              type: 'tool_result',
              name: 'write_file',
              output: out,
              durationMs: Date.now() - started,
            });
            setSpanOutput(span, out);
            return out;
          } catch (e) {
            push(transcript, {
              type: 'error',
              name: 'write_file',
              output: String(e),
              durationMs: Date.now() - started,
            });
            throw e;
          }
        },
      );
    },
    {
      name: 'write_file',
      description:
        'Create or replace a text file inside the isolated task workspace.',
      schema: writeFileSchema,
    },
  );

  // 命令工具复用 runProcess 的 allowlist 和 timeout，返回结构化退出码与输出。
  const runCommand = tool<
    typeof runCommandSchema,
    z.infer<typeof runCommandSchema>
  >(
    async (toolInput) => {
      const { command } = runCommandSchema.parse(toolInput);
      return withTelemetrySpan(
        'tool.run_command',
        {
          type: 'tool',
          input: { command },
          metadata: { tool_name: 'run_command' },
        },
        async (span) => {
          const started = Date.now();
          push(transcript, {
            type: 'tool_call',
            name: 'run_command',
            input: { command },
          });
          try {
            const result = await runProcess(
              command,
              workspaceRoot,
              commandTimeout,
            );
            push(transcript, {
              type: 'tool_result',
              name: 'run_command',
              output: result,
              durationMs: Date.now() - started,
              meta: { exitCode: result.code },
            });
            span.setAttribute('tool.exit_code', result.code);
            setSpanOutput(span, result);
            return JSON.stringify(result);
          } catch (e) {
            push(transcript, {
              type: 'error',
              name: 'run_command',
              output: String(e),
              durationMs: Date.now() - started,
            });
            throw e;
          }
        },
      );
    },
    {
      name: 'run_command',
      description:
        'Run an allowlisted build/test/typecheck command in the task workspace.',
      schema: runCommandSchema,
    },
  );

  // LangChain 需要完整工具列表来生成 tool schema；执行时再通过名称索引。
  const tools = [readFile, writeFile, runCommand];
  type AnyInvokableTool = {
    name: string;
    invoke(input: unknown): Promise<unknown>;
  };
  const toolsByName = new Map<string, AnyInvokableTool>(
    tools.map((t) => [t.name, t as unknown as AnyInvokableTool]),
  );

  const modelName = process.env.AGENT_MODEL ?? 'gpt-5-mini';
  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: modelName,
    temperature: 0,
    configuration: process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : undefined,
  }).bindTools(tools);

  const State = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (a, b) => a.concat(b),
      default: () => [],
    }),
    steps: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  });

  // agent/tools 循环最多运行 12 个模型 step，避免模型持续调用工具造成无限执行。
  const graph = new StateGraph(State)
    .addNode('agent', async (state) => {
      const started = Date.now();
      push(transcript, {
        type: 'llm_start',
        name: 'agent',
        input: { step: state.steps },
      });

      const response = await withTelemetrySpan(
        'llm.agent',
        {
          type: 'generation',
          model: modelName,
          input: state.messages.map((message) => ({
            kind: message.constructor.name,
            content: message.content,
          })),
          metadata: { step: state.steps },
        },
        async (span) => {
          const value = await model.invoke(state.messages);
          setSpanOutput(span, {
            content: value.content,
            toolCalls:
              value.tool_calls?.map((x) => ({ name: x.name, args: x.args })) ??
              [],
          });
          setGenerationUsage(
            span,
            value.usage_metadata
              ? {
                  inputTokens: value.usage_metadata.input_tokens,
                  outputTokens: value.usage_metadata.output_tokens,
                  totalTokens: value.usage_metadata.total_tokens,
                }
              : undefined,
          );
          return value;
        },
      );

      push(transcript, {
        type: 'llm_end',
        name: 'agent',
        output: response.content,
        durationMs: Date.now() - started,
        meta: { toolCalls: response.tool_calls?.map((x) => x.name) ?? [] },
      });
      return { messages: [response], steps: state.steps + 1 };
    })
    .addNode('tools', async (state) => {
      const last = state.messages.at(-1);
      if (!(last instanceof AIMessage)) return { messages: [] };
      const results: ToolMessage[] = [];
      for (const call of last.tool_calls ?? []) {
        const selected = toolsByName.get(call.name);
        if (!selected) {
          results.push(
            new ToolMessage({
              content: `Unknown tool: ${call.name}`,
              tool_call_id: call.id ?? call.name,
            }),
          );
          continue;
        }
        try {
          const value = await selected.invoke(call.args);
          results.push(
            new ToolMessage({
              content:
                typeof value === 'string' ? value : JSON.stringify(value),
              tool_call_id: call.id ?? call.name,
            }),
          );
        } catch (e) {
          results.push(
            new ToolMessage({
              content: `Tool error: ${String(e)}`,
              tool_call_id: call.id ?? call.name,
            }),
          );
        }
      }
      return { messages: results };
    })
    .addEdge(START, 'agent')
    // 没有 tool call 时认为模型已经给出最终答案；达到上限也强制结束。
    .addConditionalEdges(
      'agent',
      (state) => {
        const last = state.messages.at(-1);
        if (state.steps >= 12) return END;
        if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0)
          return 'tools';
        return END;
      },
      ['tools', END],
    )
    .addEdge('tools', 'agent')
    .compile();

  // agent_start 放在图执行之前，agent_end 则由最外层 span 在返回答案后写入。
  push(transcript, {
    type: 'agent_start',
    input: { task: input.task, workspaceRoot },
  });
  const system = `You are a production coding agent running inside an isolated workspace.\nRules:\n1. Inspect relevant files before editing.\n2. Make the smallest correct change.\n3. After editing, run the relevant typecheck/test/build command.\n4. Never access paths outside the workspace.\n5. Finish with a concise summary of changed files and validation results.`;

  return withTelemetrySpan(
    'agent.run',
    {
      type: 'agent',
      input: { task: input.task },
      model: modelName,
      metadata: { workspace_root: workspaceRoot },
    },
    async (span) => {
      setTraceMetadata(span, { agent: 'coding-agent' });
      const result = await graph.invoke({
        messages: [new SystemMessage(system), new HumanMessage(input.task)],
        steps: 0,
      });
      const answer = [...result.messages]
        .reverse()
        .find(
          (m) =>
            m instanceof AIMessage &&
            typeof m.content === 'string' &&
            m.content.length > 0,
        );
      const text =
        answer && typeof answer.content === 'string'
          ? answer.content
          : 'Agent finished without a textual final answer.';
      setSpanOutput(span, text);
      push(transcript, { type: 'agent_end', output: text });
      return text;
    },
  );
}
