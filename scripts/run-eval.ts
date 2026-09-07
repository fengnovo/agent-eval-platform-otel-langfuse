import 'dotenv/config';
import path from 'node:path';
import { initDb, persistAdapter } from '@aep/db';
import { loadSuite, runSuite } from '@aep/evaluator';
import { initTelemetry, shutdownTelemetry } from '@aep/telemetry';

initTelemetry({ serviceName: 'agent-eval-cli' });
// --ci 使用单并发，减少 CI 资源竞争，并在摘要低于阈值时返回失败状态。

try {
  const ci = process.argv.includes('--ci');
  const suiteArg =
    process.argv.find((x) => x.endsWith('.json')) ?? 'suites/coding-agent.json';
  const suite = await loadSuite(path.resolve(suiteArg));
  await initDb();
  const { summary, results } = await runSuite(suite, {
    concurrency: ci ? 1 : 2,
    persist: persistAdapter,
  });

  console.log(JSON.stringify(summary, null, 2));
  // 先输出机器可读摘要，再输出逐 Trial 结果，便于日志采集和人工诊断。
  for (const r of results) {
    console.log(
      `${r.scoreCard.passed ? 'PASS' : 'FAIL'} ${r.taskId}#${r.trialIndex} score=${r.scoreCard.totalScore.toFixed(3)} latency=${r.metrics.latencyMs}ms traceId=${r.traceId ?? '-'}`,
    );
    if (!r.scoreCard.passed) {
      for (const d of r.scoreCard.details.filter((x) => !x.passed)) {
        console.log(`  - ${d.layer}/${d.name}: ${d.reason}`);
      }
    }
  }

  if (ci && (summary.passRate < 0.8 || summary.avgScore < 0.75)) {
    // Regression gate 只在 CI 模式生效，本地运行仍会完整打印失败详情但不阻断开发。
    console.error(
      `Regression gate failed: passRate=${summary.passRate.toFixed(3)}, avgScore=${summary.avgScore.toFixed(3)}`,
    );
    process.exitCode = 1;
  }
} finally {
  // CLI 是短生命周期进程，退出前必须 flush/shutdown，避免最后几个 Span 留在缓冲区。
  await shutdownTelemetry();
}
