import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LangfuseSpanProcessor } from '@langfuse/otel';

export type TelemetryExporterMode = 'langfuse' | 'otlp' | 'off';
export type LangfuseObservationType =
  | 'span'
  | 'generation'
  | 'event'
  | 'embedding'
  | 'agent'
  | 'tool'
  | 'chain'
  | 'retriever'
  | 'guardrail'
  | 'evaluator';

export type TelemetrySpanOptions = {
  type?: LangfuseObservationType;
  input?: unknown;
  model?: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, string | number | boolean | undefined>;
};

// SDK 只在显式开启时初始化；这样 CI 默认不会向外部观测平台发送数据。
let sdk: NodeSDK | undefined;
let started = false;
let directLangfuseProcessor: LangfuseSpanProcessor | undefined;

const tracer = trace.getTracer('agent-eval-platform', '1.0.0');

/** 是否启用整个 Telemetry 旁路。 */
function enabled() {
  return process.env.TELEMETRY_ENABLED === '1';
}

/** 是否允许把任务、代码和模型输入输出写入 span。默认关闭以保护隐私。 */
function captureContent() {
  return process.env.TELEMETRY_CAPTURE_CONTENT === '1';
}

/** 把任意 metadata 转成有限长度的 span attribute 字符串。 */
function compactJson(value: unknown, max = 30000): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = JSON.stringify(String(value));
  }
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** 将 metadata key 规范化为 OTel/Langfuse 可接受的 attribute key。 */
function metadataKey(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 根据环境变量选择 direct Langfuse 或 OTLP exporter，并启动 NodeSDK。 */
export function initTelemetry(options?: { serviceName?: string }) {
  if (started || !enabled()) return;

  if (process.env.OTEL_LOG_LEVEL === 'DEBUG') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const serviceName =
    options?.serviceName ??
    process.env.OTEL_SERVICE_NAME ??
    'agent-eval-platform';
  const mode = (process.env.TELEMETRY_EXPORTER ??
    'langfuse') as TelemetryExporterMode;

  if (mode === 'off') return;

  if (mode === 'langfuse') {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      console.warn(
        '[telemetry] TELEMETRY_ENABLED=1 but LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are missing; tracing is disabled.',
      );
      return;
    }

    directLangfuseProcessor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
      environment:
        process.env.LANGFUSE_TRACING_ENVIRONMENT ??
        process.env.NODE_ENV ??
        'development',
      // Langfuse v5 filters non-GenAI spans by default. This project deliberately
      // exports evaluator/agent/tool spans too, so the complete Trial trajectory
      // appears in one trace.
      shouldExportSpan: () => true,
    });

    sdk = new NodeSDK({
      serviceName,
      spanProcessors: [directLangfuseProcessor],
    });
  } else if (mode === 'otlp') {
    const url =
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      'http://localhost:4318/v1/traces';
    sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url }),
    });
  } else {
    throw new Error(
      `Unsupported TELEMETRY_EXPORTER=${mode}. Use langfuse, otlp, or off.`,
    );
  }

  sdk.start();
  started = true;
  console.log(`[telemetry] started service=${serviceName} exporter=${mode}`);
}

/** 尽快把 direct Langfuse processor 的内存队列发送出去。 */
export async function flushTelemetry() {
  await directLangfuseProcessor?.forceFlush();
}

/** 进程退出前 flush 并释放 OTel SDK 资源。 */
export async function shutdownTelemetry() {
  if (!started || !sdk) return;
  try {
    await directLangfuseProcessor?.forceFlush();
    await sdk.shutdown();
  } finally {
    sdk = undefined;
    directLangfuseProcessor = undefined;
    started = false;
  }
}

/** 按隐私开关写入可选的 observation input。 */
export function setSpanInput(span: Span, value: unknown) {
  if (!captureContent()) return;
  span.setAttribute('langfuse.observation.input', compactJson(value));
}

/** 按隐私开关写入可选的 observation output。 */
export function setSpanOutput(span: Span, value: unknown) {
  if (!captureContent()) return;
  span.setAttribute('langfuse.observation.output', compactJson(value));
}

export function setSpanMetadata(
  span: Span,
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    const attr = `langfuse.observation.metadata.${metadataKey(key)}`;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      span.setAttribute(attr, value);
    } else {
      span.setAttribute(attr, compactJson(value, 8000));
    }
  }
}

export function setTraceMetadata(
  span: Span,
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    const attr = `langfuse.trace.metadata.${metadataKey(key)}`;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      span.setAttribute(attr, value);
    } else {
      span.setAttribute(attr, compactJson(value, 8000));
    }
  }
}

export function setGenerationUsage(
  span: Span,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
) {
  if (!usage) return;
  const details = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
  };
  span.setAttribute(
    'langfuse.observation.usage_details',
    compactJson(details, 1000),
  );
  if (usage.inputTokens !== undefined)
    span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
  if (usage.outputTokens !== undefined)
    span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
}

/**
 * 在当前 OpenTelemetry context 中创建并结束一个 Span。
 * 回调抛错时自动记录 exception、ERROR 状态，再把原错误继续抛给业务层。
 */
export async function withTelemetrySpan<T>(
  name: string,
  options: TelemetrySpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('langfuse.observation.type', options.type ?? 'span');
    if (options.model) {
      span.setAttribute('langfuse.observation.model.name', options.model);
      span.setAttribute('gen_ai.request.model', options.model);
    }
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    setSpanMetadata(span, options.metadata);
    setSpanInput(span, options.input);

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setAttribute('langfuse.observation.level', 'ERROR');
      span.setAttribute('langfuse.observation.status_message', err.message);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
