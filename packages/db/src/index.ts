import pg from 'pg';
import type { EvalSuite, RunSummary, TrialResult } from '@aep/shared';

const { Pool } = pg;
// Pool 在进程内复用数据库连接；DATABASE_URL 由 CLI/API 的 dotenv 配置提供。
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** 创建当前 schema，并用幂等 DDL 升级旧版 OTel 数据库。 */
export async function initDb() {
  await pool.query(`
    create table if not exists eval_runs (
      id uuid primary key,
      suite_id text not null,
      suite_name text not null,
      status text not null,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      summary jsonb
    );
    create table if not exists eval_trials (
      id uuid primary key,
      run_id uuid not null references eval_runs(id) on delete cascade,
      task_id text not null,
      trial_index integer not null,
      input text not null,
      outcome text not null,
      passed boolean not null,
      total_score double precision not null,
      metrics jsonb not null,
      score_card jsonb not null,
      transcript jsonb not null,
      workspace text,
      trace_id text,
      error text,
      created_at timestamptz not null default now()
    );

    -- Existing databases created by the pre-OTel version are upgraded in-place.
    alter table eval_trials add column if not exists trace_id text;
    create index if not exists eval_trials_run_id_idx on eval_trials(run_id);
    create index if not exists eval_trials_task_id_idx on eval_trials(task_id);
    create index if not exists eval_trials_trace_id_idx on eval_trials(trace_id);
  `);
}

/** Evaluator 使用的持久化适配器，按 Run 开始、Trial 完成、Run 结束分阶段写入。 */
export const persistAdapter = {
  async saveRunStart(runId: string, suite: EvalSuite) {
    await pool.query(
      "insert into eval_runs(id,suite_id,suite_name,status) values($1,$2,$3,'running')",
      [runId, suite.id, suite.name],
    );
  },
  async saveTrial(t: TrialResult) {
    await pool.query(
      `insert into eval_trials(
        id,run_id,task_id,trial_index,input,outcome,passed,total_score,
        metrics,score_card,transcript,workspace,trace_id,error
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        t.id,
        t.runId,
        t.taskId,
        t.trialIndex,
        t.input,
        t.outcome,
        t.scoreCard.passed,
        t.scoreCard.totalScore,
        JSON.stringify(t.metrics),
        JSON.stringify(t.scoreCard),
        JSON.stringify(t.transcript),
        t.workspace,
        t.traceId ?? null,
        t.error ?? null,
      ],
    );
  },
  async saveRunEnd(s: RunSummary) {
    await pool.query(
      "update eval_runs set status='completed', ended_at=$2, summary=$3 where id=$1",
      [s.runId, s.endedAt, JSON.stringify(s)],
    );
  },
};

/** 返回最近的评测运行摘要，供 Dashboard 首页展示。 */
export async function listRuns(limit = 30) {
  const r = await pool.query(
    'select * from eval_runs order by started_at desc limit $1',
    [limit],
  );
  return r.rows;
}

/** 查询一个 Run 及其按 task/trial 排序的全部 Trial 详情。 */
export async function getRun(id: string) {
  const run = await pool.query('select * from eval_runs where id=$1', [id]);
  const trials = await pool.query(
    'select * from eval_trials where run_id=$1 order by task_id, trial_index',
    [id],
  );
  return { run: run.rows[0] ?? null, trials: trials.rows };
}
