// DashScope text-embedding-v4 封装（阿里云百炼 OpenAI 兼容模式）
// 纯函数、不依赖 Parse（风格对齐 llm.js，便于单测）
// 说明：DeepSeek 无 embedding 接口，向量化独立走 DashScope；方案见 docs/rag-knowledge-base.md §2.2
const config = require('../../config');

// DashScope 单次请求文本条数上限（text-embedding-v4 为 10 条）
function embed(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return Promise.resolve([]);
  const { EMBEDDING_API_KEY, EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } =
    config.KNOWLEDGE;
  if (!EMBEDDING_API_KEY) {
    return Promise.reject(new Error('缺少 DASHSCOPE_API_KEY，请在 .env 配置'));
  }

  return fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: list, dimensions: EMBEDDING_DIMENSIONS }),
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`embedding 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    return res.json();
  }).then((data) => {
    // 按 index 排序回填，防 API 乱序返回
    const vectors = new Array(list.length);
    (data.data || []).forEach((d) => {
      vectors[d.index] = d.embedding;
    });
    return Array.isArray(texts) ? vectors : vectors[0];
  });
}

// 批量向量化：按 BATCH_LIMIT 分批串行调用，返回与输入等长的向量数组
async function embedBatch(texts) {
  const { EMBEDDING_BATCH_LIMIT } = config.KNOWLEDGE;
  const out = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_LIMIT) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_LIMIT);
    out.push(...(await embed(batch)));
  }
  return out;
}

module.exports = { embed, embedBatch };
