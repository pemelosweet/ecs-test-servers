// 环境变量与默认值（所有配置的唯一出口）
const config = {
  // Parse Server 基础配置
  APP_ID: process.env.PARSE_APP_ID || 'ecs-app',
  MASTER_KEY: process.env.PARSE_MASTER_KEY || 'ecs-master-key-dev',
  SERVER_URL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
  PUBLIC_SERVER_URL: process.env.PUBLIC_SERVER_URL || process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
  DATABASE_URI: process.env.DATABASE_URI || 'mongodb://localhost:27017/ecs',
  PORT: parseInt(process.env.PORT, 10) || 1337,
  IS_PRODUCTION: process.env.NODE_ENV === 'production',

  // Dashboard 账号
  DASHBOARD_USER: process.env.PARSE_DASHBOARD_USER ,
  DASHBOARD_PASSWORD: process.env.PARSE_DASHBOARD_PASSWORD ,

  // 阿里云 OSS（未配置 OSS_BUCKET_NAME 时回退 MongoDB GridFS）
  OSS: {
    ACCESS_KEY_ID: process.env.OSS_ACCESS_KEY_ID,
    ACCESS_KEY_SECRET: process.env.OSS_ACCESS_KEY_SECRET,
    BUCKET_NAME: process.env.OSS_BUCKET_NAME,
    REGION: process.env.OSS_REGION,
    ENDPOINT: process.env.OSS_ENDPOINT,
    // 图片对外访问地址：生产建议绑定自定义域名后填 https://img.xxx.com，
    // 否则回退到 OSS 原生域名（默认域名对匿名请求可能强制下载，见 docs/image-hosting.md）
    PUBLIC_URL: process.env.OSS_PUBLIC_URL,
    // true = 直接返回 OSS/CDN 地址（需自定义域名可预览）；默认 false = 走 Parse /parse/files 代理取图（可预览）
    DIRECT_ACCESS: process.env.OSS_DIRECT_ACCESS === 'true',
  },

  // 图床（服务端签名直传 OSS）
  IMAGE_HOST: {
    MAX_SIZE_MB: parseInt(process.env.IMAGE_HOST_MAX_SIZE_MB, 10) || 10,
    KEY_PREFIX: process.env.IMAGE_HOST_KEY_PREFIX || 'images',
  },
};

// 启动自检：生产的对外地址绝不能是本地回环，防本地 .env 误抄进 PROD_ENV 的事故
if (config.IS_PRODUCTION && /localhost|127\.0\.0\.1/.test(config.PUBLIC_SERVER_URL)) {
  console.error('[config] PUBLIC_SERVER_URL 仍是本地地址，请在 PROD_ENV secret 配置对外域名（见 deploy/DEPLOY.md）');
}

module.exports = config;
