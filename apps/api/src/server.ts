import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import { initDb, persistAdapter, listRuns, getRun } from '@aep/db';
import { loadSuite, runSuite } from '@aep/evaluator';
import { initTelemetry, shutdownTelemetry } from '@aep/telemetry';

initTelemetry({ serviceName: 'agent-eval-api' });
// API 是长生命周期进程，因此启动时初始化 OTel，并在 SIGTERM/SIGINT 时关闭。

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await initDb();
// 健康检查不触发数据库查询，适合容器编排系统快速探活。

app.get('/health', async () => ({ ok: true }));
app.get('/runs', async () => listRuns());
// 首页只需要最近的 Run 摘要；详情由 /runs/:id 单独加载。
app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
  const data = await getRun(req.params.id);
  if (!data.run) return reply.code(404).send({ error: 'run not found' });
  return data;
});
app.post<{ Body: { suite?: string; trials?: number; concurrency?: number } }>(
  '/runs',
  async (req) => {
    const suitePath = path.resolve(
      req.body?.suite ?? 'suites/coding-agent.json',
    );
    const suite = await loadSuite(suitePath);
    const { summary } = await runSuite(suite, {
      trials: req.body?.trials,
      concurrency: req.body?.concurrency,
      persist: persistAdapter,
    });
    return summary;
  },
);
// POST 会同步执行整套 Suite，适合本地参考项目；生产服务通常应改成异步 job。

const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });

/** 先停止接收请求，再 flush OTel，避免进程退出时丢失最后几个 Span。 */
async function gracefulShutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await shutdownTelemetry();
}
process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
