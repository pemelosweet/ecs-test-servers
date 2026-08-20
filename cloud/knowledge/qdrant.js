// Qdrant REST 客户端（纯函数、不依赖 Parse，风格对齐 llm.js）
// 部署与安全见 docs/rag-knowledge-base.md §9：仅内网 127.0.0.1 暴露
const crypto = require('crypto');
const config = require('../../config');

function qdrantBase() {
  return config.KNOWLEDGE.QDRANT_URL.replace(/\/$/, '');
}

// 统一请求：带可选 api-key；非 2xx 抛带响应体的错
async function qfetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (config.KNOWLEDGE.QDRANT_API_KEY) headers['api-key'] = config.KNOWLEDGE.QDRANT_API_KEY;
  const res = await fetch(`${qdrantBase()}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant 请求失败（${options.method || 'GET'} ${path}，HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  return res.json();
}

// Parse objectId（10 位字母数字）不是合法 UUID，用 md5 映射成确定性 UUID，
// 同一 chunkId 永远得到同一 id → upsert 天然幂等（重建向量不会重复）
function toUuid(chunkId) {
  const hex = crypto.createHash('md5').update(String(chunkId)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 集合自愈：不存在则按 HNSW + cosine 创建（维度取 embedding 配置）
async function ensureCollection() {
  const name = config.KNOWLEDGE.QDRANT_COLLECTION;
  const check = await fetch(`${qdrantBase()}/collections/${name}`, {
    headers: config.KNOWLEDGE.QDRANT_API_KEY
      ? { 'api-key': config.KNOWLEDGE.QDRANT_API_KEY }
      : {},
  });
  if (check.ok) return; // 已存在
  await qfetch(`/collections/${name}`, {
    method: 'PUT',
    body: JSON.stringify({
      vectors: { size: config.KNOWLEDGE.EMBEDDING_DIMENSIONS, distance: 'Cosine' },
    }),
  });
}

// 批量写入：points = [{ chunkId, vector, payload }]
async function upsertPoints(points) {
  if (!points.length) return;
  await ensureCollection();
  const name = config.KNOWLEDGE.QDRANT_COLLECTION;
  await qfetch(`/collections/${name}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points: points.map((p) => ({ id: toUuid(p.chunkId), vector: p.vector, payload: p.payload })),
    }),
  });
}

// 向量检索：返回 [{ score, payload }]（按分数降序，Qdrant 默认）
async function search(vector, { limit = 20, scoreThreshold } = {}) {
  await ensureCollection();
  const name = config.KNOWLEDGE.QDRANT_COLLECTION;
  const body = { vector, limit, with_payload: true };
  if (scoreThreshold != null) body.score_threshold = scoreThreshold;
  const data = await qfetch(`/collections/${name}/points/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return (data.result || []).map((p) => ({ score: p.score, payload: p.payload || {} }));
}

// 按 documentId 删除全部向量（文档删除时同步清理）
async function deleteByDocument(documentId) {
  const name = config.KNOWLEDGE.QDRANT_COLLECTION;
  await qfetch(`/collections/${name}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
    }),
  });
}

module.exports = { upsertPoints, search, deleteByDocument, ensureCollection };
