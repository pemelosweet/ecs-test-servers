// 环境变量与默认值（所有配置的唯一出口）
module.exports = {
  // Parse Server 基础配置
  APP_ID: process.env.PARSE_APP_ID || 'ecs-app',
  MASTER_KEY: process.env.PARSE_MASTER_KEY || 'ecs-master-key-dev',
  SERVER_URL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
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
  },
};
