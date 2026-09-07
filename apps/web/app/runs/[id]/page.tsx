const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const LANGFUSE_BASE = process.env.NEXT_PUBLIC_LANGFUSE_BASE_URL;
// 详情页的数据来自 API；fetch no-store 确保刚完成的 Run 能立即看到。
const LANGFUSE_PROJECT_ID = process.env.NEXT_PUBLIC_LANGFUSE_PROJECT_ID;

async function load(id: string) {
  const r = await fetch(`${API}/runs/${id}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Run not found');
  return r.json();
}

function langfuseTraceUrl(traceId: string | undefined) {
  // 只有同时配置 Langfuse 地址、项目 ID 和 traceId 时才显示外链。
  if (!traceId || !LANGFUSE_BASE || !LANGFUSE_PROJECT_ID) return undefined;
  return `${LANGFUSE_BASE.replace(/\/$/, '')}/project/${LANGFUSE_PROJECT_ID}/traces/${traceId}`;
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await load(id);
  const run = data.run;
  const trials: any[] = data.trials;

  // Next.js 当前路由参数是 Promise，需要先解析再查询 API。
  return (
    <>
      <div className='top'>
        <div>
          <a href='/'>← Runs</a>
          <h1>{run.suite_name}</h1>
        </div>
        <span className='pill'>{run.status}</span>
      </div>
      <div className='grid'>
        <div className='card'>
          <div className='muted'>Pass rate</div>
          <div className='metric'>
            {((run.summary?.passRate ?? 0) * 100).toFixed(1)}%
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Avg score</div>
          <div className='metric'>
            {Number(run.summary?.avgScore ?? 0).toFixed(3)}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>P95</div>
          <div className='metric'>
            {Math.round(run.summary?.p95LatencyMs ?? 0)}ms
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Failed</div>
          <div className='metric'>{run.summary?.failed ?? 0}</div>
        </div>
      </div>

      <h2>Trials</h2>
      {trials.map((t: any) => {
        {
          /* 每个 Trial 展开后同时展示 OTel 关联、最终答案、原始轨迹和逐项评分。 */
        }
        const traceUrl = langfuseTraceUrl(t.trace_id);
        return (
          <details className='card' key={t.id} style={{ marginBottom: 10 }}>
            <summary>
              <b>{t.task_id}</b> · trial {t.trial_index} ·{' '}
              <span className={t.passed ? 'pass' : 'fail'}>
                {t.passed ? 'PASS' : 'FAIL'}
              </span>{' '}
              · score {Number(t.total_score).toFixed(3)}
            </summary>
            <div style={{ marginTop: 10 }}>
              <div className='muted'>OpenTelemetry traceId</div>
              <code>{t.trace_id ?? 'telemetry disabled'}</code>
              {traceUrl ? (
                <>
                  {' · '}
                  <a href={traceUrl} target='_blank' rel='noreferrer'>
                    Open in Langfuse ↗
                  </a>
                </>
              ) : null}
            </div>
            <div className='details' style={{ marginTop: 12 }}>
              <div>
                <h3>Outcome</h3>
                <div className='card'>{t.outcome || t.error}</div>
                <h3>Transcript</h3>
                <div className='trace'>
                  {JSON.stringify(t.transcript, null, 2)}
                </div>
              </div>
              <div>
                <h3>Scorers</h3>
                {(t.score_card?.details ?? []).map((s: any) => (
                  <div
                    className='card'
                    key={s.name}
                    style={{ marginBottom: 8 }}
                  >
                    <b>
                      {s.layer} · {s.name}
                    </b>
                    <div className={s.passed ? 'pass' : 'fail'}>
                      {s.passed ? 'PASS' : 'FAIL'} ·{' '}
                      {Number(s.score).toFixed(3)}
                    </div>
                    <div className='muted' style={{ whiteSpace: 'pre-wrap' }}>
                      {s.reason}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        );
      })}
    </>
  );
}
