import { OpenAIEmbeddings } from '@langchain/openai';
import type { ScoreDetail } from '@aep/shared';

/** 计算两个 embedding 向量的余弦相似度；零向量时返回 0，避免 NaN。 */
function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * L2 语义评分器：把 Agent 最终答案与参考答案编码后比较方向相似度。
 * 它是可选的软信号，必须由环境变量和任务 referenceAnswer 同时开启。
 */
export async function semanticScorer(
  actual: string,
  expected: string,
  threshold: number,
): Promise<ScoreDetail> {
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    configuration: process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : undefined,
  });
  const [a, b] = await embeddings.embedDocuments([actual, expected]);
  const score = cosine(a ?? [], b ?? []);
  return {
    name: 'semantic_similarity',
    layer: 'L2',
    score,
    passed: score >= threshold,
    reason: `Cosine similarity ${score.toFixed(4)} (threshold ${threshold})`,
  };
}
