// DeepSeek 对话模型封装（OpenAI 兼容接口）
// 纯函数、不依赖 Parse（风格对齐 oss-sign.js，便于单测）
// 说明：DeepSeek 仅提供 chat 接口，无 embedding 接口；向量化方案见 docs/rag-knowledge-base.md
const config = require('../../config');

// 通义千问 → DeepSeek：聊天补全（默认 deepseek-chat，见 config.KNOWLEDGE.LLM_MODEL）
async function chat(messages, { temperature = 0.7, maxTokens } = {}) {
  const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = config.KNOWLEDGE;
  if (!LLM_API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 配置');
  }

  const body = {
    model: LLM_MODEL,
    messages,
    temperature,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat };
