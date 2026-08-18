// 知识库问答 Cloud 函数（RAG 检索增强生成）
// 接口契约：
//   入参：{ question: string }
//   返回：{ answer: string, sources: [{ id, title, content, score }] }
// 链路：question → embedding → Qdrant 召回（带阈值）→ 按 chunkId 回 Mongo 取正文
//      → grounding prompt（强制 [1][2] 引用 + 拒答）→ DeepSeek → 写 QueryLog
// 技术调研见 docs/rag-knowledge-base.md
const config = require('../config');
const { chat } = require('./llm');
const { embed } = require('./embedding');
const { search } = require('./qdrant');

// 检测知识库服务是否就绪（DeepSeek + DashScope 两把 key 都必须）
function assertReady() {
  const { LLM_API_KEY, EMBEDDING_API_KEY } = config.KNOWLEDGE;
  if (!LLM_API_KEY || !EMBEDDING_API_KEY) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      '知识库服务尚未配置（缺少 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY），请联系管理员'
    );
  }
}

// Grounding 约束：只依据资料回答 + 强制引用编号 + 明确拒答（见 docs §8.1/§8.2）
const SYSTEM_PROMPT = `你是一名专业的知识库助手，请严格依据用户提供的「参考资料」回答问题。
回答要求：
1. 只依据参考资料回答，资料中没有的内容一律不编造
2. 每个关键断言末尾标注所依据的资料编号，如 [1][2]
3. 参考资料不足以回答时，直接回复「知识库中未找到相关内容」，不要猜测
4. 回答准确、简洁、结构化（适当使用 Markdown 列表/标题）`;

// 拒答文案（召回为空 / 召回块正文全缺失时统一返回，不消耗 LLM）
const NO_HIT_ANSWER = '知识库中未找到相关内容，请换个问法，或先上传相关文档。';

// 问答日志：失败仅告警，不影响主流程（准确性闭环，见 docs §8.4）
async function logQuery(request, question, answer, retrievedChunks, startedAt) {
  try {
    const log = new Parse.Object('QueryLog');
    log.set('question', question.slice(0, 500));
    log.set('answer', (answer || '').slice(0, 2000));
    log.set('retrievedChunks', retrievedChunks);
    log.set('latency', Date.now() - startedAt);
    log.set('user', request.user);
    await log.save(null, { useMasterKey: true });
  } catch (err) {
    console.error('[knowledge] QueryLog 写入失败：', err.message);
  }
}

// 问答入口（需登录，防匿名刷 LLM 成本）
Parse.Cloud.define(
  'askKnowledge',
  async (request) => {
    const { question } = request.params || {};
    if (!question?.trim()) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '请输入问题');
    }
    assertReady();

    const startedAt = Date.now();
    const { RETRIEVAL_CANDIDATES, RETRIEVAL_TOP_K, RETRIEVAL_SCORE_THRESHOLD, MAX_CONTEXT_CHARS } =
      config.KNOWLEDGE;

    try {
      // 1. 问题向量化 + 召回（score_threshold 在 Qdrant 侧过滤低分）
      const qVector = await embed(question.trim());
      const hits = await search(qVector, {
        limit: RETRIEVAL_CANDIDATES,
        scoreThreshold: RETRIEVAL_SCORE_THRESHOLD,
      });

      // 拒答：最高分都不达标 → 不走 LLM，直接返回（省 token、防幻觉）
      if (!hits.length) {
        await logQuery(request, question, NO_HIT_ANSWER, [], startedAt);
        return { answer: NO_HIT_ANSWER, sources: [] };
      }

      // 2. 按 chunkId 回 Mongo 取正文（containedIn 一次查回）
      const chunkIds = hits.map((h) => h.payload.chunkId);
      const chunkQuery = new Parse.Query('Chunk');
      chunkQuery.containedIn('objectId', chunkIds);
      chunkQuery.limit(chunkIds.length);
      const chunkObjs = await chunkQuery.find({ useMasterKey: true });
      const contentById = new Map(chunkObjs.map((c) => [c.id, c.get('content')]));

      // 3. 组装 topK 资料（总长上限防 prompt 溢出；孤儿向量跳过）
      const materials = [];
      let chars = 0;
      for (const h of hits) {
        if (materials.length >= RETRIEVAL_TOP_K) break;
        const content = contentById.get(h.payload.chunkId);
        if (!content) continue; // Mongo 已删的残留向量，跳过
        if (chars + content.length > MAX_CONTEXT_CHARS) break;
        chars += content.length;
        materials.push({
          chunkId: h.payload.chunkId,
          title: h.payload.title || '未命名文档',
          content,
          score: Number(h.score.toFixed(4)),
        });
      }
      if (!materials.length) {
        await logQuery(request, question, NO_HIT_ANSWER, [], startedAt);
        return { answer: NO_HIT_ANSWER, sources: [] };
      }

      // 4. Grounding 生成（低温度，减少发挥）
      const context = materials
        .map((m, i) => `【资料 ${i + 1}】（来源：${m.title}）\n${m.content}`)
        .join('\n\n');
      const answer = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `参考资料：\n${context}\n\n问题：${question.trim()}` },
        ],
        { temperature: 0.2 }
      );

      // LLM 级拒答（grounding 约束触发）：清空 sources，避免前端「拒答+参考来源」自相矛盾
      const refused = answer.includes('知识库中未找到相关内容');

      await logQuery(
        request,
        question,
        answer,
        materials.map((m) => m.chunkId),
        startedAt
      );
      return {
        answer,
        sources: refused
          ? []
          : materials.map((m) => ({
              id: m.chunkId,
              title: m.title,
              content: m.content.slice(0, 200),
              score: m.score,
            })),
      };
    } catch (err) {
      console.error('[knowledge] 问答失败：', err.message);
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `问答服务异常：${err.message}`);
    }
  },
  { requireUser: true }
);
