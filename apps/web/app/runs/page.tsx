import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3031'; // 评测平台 API 地址

async function getRuns() {
  try {
    const r = await fetch(`${API}/runs`, { cache: 'no-store' });
    if (!r.ok) return [];
    return r.json();
  } catch {
    return [];
  }
}

export default async function RunsPage() {
  const runs: any[] = await getRuns();

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1 style={{ margin: 0 }}>Evaluation Runs / 评测运行</h1>
          <div className="muted">All evaluation runs · 所有评测运行记录</div>
        </div>
        <Link href="/">← Back to Dashboard</Link>
      </div>

      {runs.length === 0 ? (
        <div className="card">暂无运行记录。</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Run / 运行</th>
              <th>Suite / 套件</th>
              <th>Status / 状态</th>
              <th>Trials / 试跑数</th>
              <th>Pass rate / 通过率</th>
              <th>Started / 开始时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x: any) => {
              const summary = x.summary ?? {};
              return (
                <tr key={x.id}>
                  <td>
                    <Link href={`/runs/${x.id}`}>{x.id.slice(0, 8)}</Link>
                  </td>
                  <td>{x.suite_name}</td>
                  <td>
                    <span className="pill">{x.status}</span>
                  </td>
                  <td>{summary.trials ?? '-'}</td>
                  <td>
                    {summary.passRate != null
                      ? `${(summary.passRate * 100).toFixed(1)}%`
                      : '-'}
                  </td>
                  <td>{new Date(x.started_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
