// 环境变量与默认值（所有配置的唯一出口）
// 分层约定：
//   - 密钥（*_KEY / *_SECRET / *_PASSWORD / APP_KEY）只从环境变量读，无默认值或仅 dev 兜底
//   - 非密钥逻辑配置（应用标识 / 资源标识 / 端点 / 固定业务参数）在此给默认值，仍可被环境变量覆盖
const PORT = parseInt(process.env.PORT, 10) || 1337;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const config = {
  // ---------- Parse Server ----------
  APP_ID: process.env.PARSE_APP_ID || 'xmg', // 非密钥，需与前端 lib/parse.js 一致
  MASTER_KEY: process.env.PARSE_MASTER_KEY || 'ecs-master-key-dev', // 密钥：生产必须覆盖
  SERVER_URL: process.env.PARSE_SERVER_URL || `http://localhost:${PORT}/parse`,
  // 对外地址默认按环境推导：生产走项目常量域名（与 nginx/DEPLOY.md 一致），开发走回环；
  // 仍可用环境变量覆盖
  PUBLIC_SERVER_URL:
    process.env.PUBLIC_SERVER_URL ||
    (IS_PRODUCTION ? 'https://admin.xmg111.xyz/parse' : `http://localhost:${PORT}/parse`),
  // MongoDB 默认连本机（本地 Mac / 生产 ECS 都是应用与 MongoDB 同机部署）；
  // 仅当数据库迁到独立服务器/云上时，才需用 DATABASE_URI 环境变量覆盖
  DATABASE_URI: process.env.DATABASE_URI || 'mongodb://127.0.0.1:27017/ecs',
  PORT,
  IS_PRODUCTION,

  // ---------- Parse Dashboard ----------
  DASHBOARD_USER: process.env.PARSE_DASHBOARD_USER || 'xmg001', // 非密钥（登录用户名）
  DASHBOARD_PASSWORD: process.env.PARSE_DASHBOARD_PASSWORD || '', // 密钥

  // ---------- 阿里云 OSS（文件存储） ----------
  OSS: {
    ACCESS_KEY_ID: process.env.OSS_ACCESS_KEY_ID || '', // 密钥
    ACCESS_KEY_SECRET: process.env.OSS_ACCESS_KEY_SECRET || '', // 密钥
    BUCKET_NAME: process.env.OSS_BUCKET_NAME || 'xiaomge-1', // 资源标识（非密钥）
    REGION: process.env.OSS_REGION || 'cn-beijing',
    ENDPOINT: process.env.OSS_ENDPOINT || 'oss-cn-beijing.aliyuncs.com',
    // 图片对外访问地址：生产建议绑定自定义域名后填 https://img.xxx.com，否则回退 OSS 原生域名
    PUBLIC_URL: process.env.OSS_PUBLIC_URL || '',
    // true = 直接返回 OSS/CDN 地址；默认 false = 走 Parse /files 代理取图（可预览）
    DIRECT_ACCESS: process.env.OSS_DIRECT_ACCESS === 'true',
  },

  // ---------- 图床（服务端签名直传 OSS） ----------
  IMAGE_HOST: {
    MAX_SIZE_MB: parseInt(process.env.IMAGE_HOST_MAX_SIZE_MB, 10) || 10,
    KEY_PREFIX: process.env.IMAGE_HOST_KEY_PREFIX || 'images',
  },

  // ---------- 阿里云短信（号码认证 dypnsapi） ----------
  SMS: {
    ACCESS_KEY_ID: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '', // 密钥
    ACCESS_KEY_SECRET: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '', // 密钥
    ENDPOINT: 'dypnsapi.aliyuncs.com',
    SIGN_NAME: process.env.SMS_SIGN_NAME || '恒创联众', // 非密钥（签名/模板为固定业务参数）
    TEMPLATE_CODE: process.env.SMS_TEMPLATE_CODE || '100001',
    SCHEME_NAME: process.env.SMS_SCHEME_NAME || '', // 可选：方案名称，不填用默认方案
  },

  // ---------- 阿里云图形认证 ----------
  CAPTCHA: {
    // APP_ID 非机密（前端 RegisterPage 也硬编码）；APP_KEY 是密钥
    APP_ID: process.env.GRAPHIC_CAPTCHA_APP_ID || 'aa2c323d207de88c6219f173f088db50',
    APP_KEY: process.env.GRAPHIC_CAPTCHA_APP_KEY || '',
    VALIDATE_URL: 'https://captcha.alicaptcha.com/validate',
    // 开关：临时停用（false）；恢复时置 true 并同步前端 RegisterPage 的 GRAPHIC_CAPTCHA_ENABLED
    ENABLED: false,
  },

  // ---------- 初始管理员（seed 幂等创建/提升） ----------
  ADMIN: {
    INIT_USERNAME: process.env.ADMIN_INIT_USERNAME || 'xmg001', // 非密钥
    INIT_PASSWORD: process.env.ADMIN_INIT_PASSWORD || 'admin123456', // 生产务必覆盖
  },

  // ---------- 知识库（RAG） ----------
  KNOWLEDGE: {
    // DeepSeek 对话模型（key 为密钥；DeepSeek 无 embedding 接口，向量化方案 见 docs/rag-knowledge-base.md）
    LLM_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    LLM_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    LLM_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    // Embedding：阿里云百炼 DashScope（OpenAI 兼容模式），key 为密钥
    EMBEDDING_API_KEY: process.env.DASHSCOPE_API_KEY || '',
    EMBEDDING_BASE_URL: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    EMBEDDING_MODEL: process.env.DASHSCOPE_MODEL || 'text-embedding-v3',
    EMBEDDING_DIMENSIONS: parseInt(process.env.DASHSCOPE_DIMENSIONS, 10) || 1024,
    EMBEDDING_BATCH_LIMIT: 10, // text-embedding-v3 单次最多 10 条
    // Qdrant 向量库（本机部署，仅内网访问；集合名固定，向量与 Mongo Chunk 用 chunkId 关联）
    QDRANT_URL: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    QDRANT_API_KEY: process.env.QDRANT_API_KEY || '',
    QDRANT_COLLECTION: 'knowledge',
    // 检索参数：候选数 → 阈值过滤 → 取 topK 拼 prompt（重排暂缓，见 docs §3）
    RETRIEVAL_CANDIDATES: 20,
    RETRIEVAL_TOP_K: 5,
    RETRIEVAL_SCORE_THRESHOLD: 0.25, // cosine 相似度低于此值视为未命中 → 拒答
    MAX_CONTEXT_CHARS: 6000, // 拼进 prompt 的召回正文总长上限
  },
};

// 启动自检：生产的对外地址绝不能是本地回环，防本地 .env 误抄进 PROD_ENV 的事故
if (config.IS_PRODUCTION && /localhost|127\.0\.0\.1/.test(config.PUBLIC_SERVER_URL)) {
  console.error('[config] PUBLIC_SERVER_URL 仍是本地地址，请在 PROD_ENV secret 配置对外域名（见 ecs-infra/docs/DEPLOY.md）');
}

module.exports = config;
