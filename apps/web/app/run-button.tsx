'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3031'; // 评测平台 API 地址

export function RunButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  async function handleRun() {
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch(`${API}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const summary = data.passRate != null
        ? `${data.passed}/${data.trials} 成功 · 通过率 ${(data.passRate * 100).toFixed(0)}%`
        : '完成';
      setResult(summary);
      router.refresh();
    } catch (e: any) {
      setResult(`失败: ${e.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {result && (
        <span className="muted" style={{ fontSize: 13 }}>{result}</span>
      )}
      <button
        onClick={handleRun}
        disabled={running}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: 'none',
          background: running ? '#e5e9f0' : '#172033',
          color: running ? '#6d7788' : 'white',
          cursor: running ? 'not-allowed' : 'pointer',
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        {running ? 'Running… (~80s) · 执行中' : '▶ Run Evaluation / 运行评测'}
      </button>
    </div>
  );
}
