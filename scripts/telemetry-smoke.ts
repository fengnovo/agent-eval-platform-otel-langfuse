import 'dotenv/config';
import {
  initTelemetry,
  setSpanOutput,
  setTraceMetadata,
  shutdownTelemetry,
  withTelemetrySpan,
} from '@aep/telemetry';

initTelemetry({ serviceName: 'agent-eval-telemetry-smoke' });
// 创建一个父子 Span，验证 exporter、context 传播和 graceful shutdown 都可用。

try {
  const traceId = await withTelemetrySpan(
    'telemetry.smoke',
    {
      type: 'agent',
      input: { message: 'hello telemetry' },
      metadata: { smoke_test: true },
    },
    async (span) => {
      setTraceMetadata(span, {
        smoke_test: true,
        source: 'pnpm telemetry:smoke',
      });
      await withTelemetrySpan(
        'tool.smoke',
        { type: 'tool', input: { value: 1 } },
        async (child) => {
          setSpanOutput(child, { value: 2 });
          return 2;
        },
      );
      setSpanOutput(span, { ok: true });
      return span.spanContext().traceId;
    },
  );
  console.log(`Telemetry smoke trace created. traceId=${traceId}`);
} finally {
  await shutdownTelemetry();
}
