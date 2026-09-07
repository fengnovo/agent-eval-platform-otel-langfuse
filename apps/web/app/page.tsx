const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
// Dashboard 使用服务端组件直接请求 API，避免把数据库访问凭据暴露给浏览器。
async function getRuns() {
  try {
    const r = await fetch(`${API}/runs`, { cache: 'no-store' });
    if (!r.ok) return [];
    return r.json();
  } catch {
    return [];
  }
}
// 首页请求失败时返回空列表，让 UI 仍能展示启动提示。
export default async function Home() {
  const runs: any[] = await getRuns();
  const latest = runs[0];
  const s = latest?.summary ?? {};
  return (
    <>
      <div className='top'>
        <div>
          <h1 style={{ margin: 0 }}>Agent Evaluation Platform</h1>
          <div className='muted'>
            Trial · Transcript · L1/L2/L3 Scorer · Regression Gate
          </div>
        </div>
        <code>TypeScript + LangGraph</code>
      </div>
      <div className='grid'>
        <div className='card'>
          <div className='muted'>Pass Rate</div>
          <div className='metric'>
            {s.passRate != null ? `${(s.passRate * 100).toFixed(1)}%` : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Avg Score</div>
          <div className='metric'>
            {s.avgScore != null ? s.avgScore.toFixed(3) : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>P95 Latency</div>
          <div className='metric'>
            {s.p95LatencyMs != null ? `${Math.round(s.p95LatencyMs)}ms` : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Trials</div>
          <div className='metric'>{s.trials ?? '-'}</div>
        </div>
      </div>
      <h2>Evaluation Runs</h2>
      <table className='table'>
        <thead>
          <tr>
            <th>Run</th>
            <th>Suite</th>
            <th>Status</th>
            <th>Pass rate</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((x: any) => (
            <tr key={x.id}>
              <td>
                <a href={`/runs/${x.id}`}>{x.id.slice(0, 8)}</a>
              </td>
              <td>{x.suite_name}</td>
              <td>
                <span className='pill'>{x.status}</span>
              </td>
              <td>
                {x.summary ? `${(x.summary.passRate * 100).toFixed(1)}%` : '-'}
              </td>
              <td>{new Date(x.started_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length === 0 && (
        <div className='card' style={{ marginTop: 12 }}>
          No runs yet. Start PostgreSQL + API, then run <code>pnpm eval</code>.
        </div>
      )}
    </>
  );
}
