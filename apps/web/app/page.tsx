import { RunButton } from './run-button';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3031'; // 评测平台 API 地址
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
          <h1 style={{ margin: 0 }}>
            Agent Evaluation Platform <span className="muted">/ Agent 评测平台</span>
          </h1>
          <div className='muted'>
            Trial · Transcript · L1/L2/L3 Scorer · Regression Gate · 试跑 · 轨迹 · 评分器 · 回归门禁
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <RunButton />
        </div>
      </div>
      <div className='grid'>
        <div className='card'>
          <div className='muted'>Pass Rate / 通过率</div>
          <div className='metric'>
            {s.passRate != null ? `${(s.passRate * 100).toFixed(1)}%` : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Avg Score / 平均分</div>
          <div className='metric'>
            {s.avgScore != null ? s.avgScore.toFixed(3) : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>P95 Latency / P95 延迟</div>
          <div className='metric'>
            {s.p95LatencyMs != null ? `${Math.round(s.p95LatencyMs)}ms` : '-'}
          </div>
        </div>
        <div className='card'>
          <div className='muted'>Trials / 试跑次数</div>
          <div className='metric'>{s.trials ?? '-'}</div>
        </div>
      </div>
      <h2>Evaluation Runs / 评测运行</h2>
      <table className='table'>
        <thead>
          <tr>
            <th>Run / 运行</th>
            <th>Suite / 套件</th>
            <th>Status / 状态</th>
            <th>Pass rate / 通过率</th>
            <th>Started / 开始时间</th>
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
          暂无运行记录。请先启动 PostgreSQL + API，然后运行 <code>pnpm eval</code>，或点击右上角按钮直接触发。
        </div>
      )}
    </>
  );
}
