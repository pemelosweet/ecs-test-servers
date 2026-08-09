// 入口文件：只做组装和启动，各模块职责见对应文件
//   config.js    → 环境变量配置
//   oss.js       → 文件存储（阿里云 OSS）
//   dashboard.js → Parse Dashboard
//   schema.js    → Schema 初始化
//   cloud/main.js → 业务 Cloud 函数
require('dotenv').config();

const express = require('express');
const { ParseServer } = require('parse-server');
const config = require('./config');
const buildOssAdapter = require('./oss');
const dashboard = require('./dashboard');
const initSchema = require('./schema');

// ---------- Parse Server 实例 ----------
const ossAdapter = buildOssAdapter();
const parseServer = new ParseServer({
  databaseURI: config.DATABASE_URI,
  appId: config.APP_ID,
  masterKey: config.MASTER_KEY,
  serverURL: config.SERVER_URL,
  // 对外地址：文件（头像）URL 依赖它拼接，缺失会得到 undefined/files/...
  publicServerURL: process.env.PUBLIC_SERVER_URL || config.SERVER_URL,
  cloud: __dirname + '/cloud/main.js',
  // 允许不带 masterKey 直接创建新 class（仅限开发环境）
  allowClientClassCreation: !config.IS_PRODUCTION,
  // 注册唯一入口是 Cloud 函数 register（带滑块校验）；
  // 直接 POST /users 建号由 cloud/main.js 的 beforeSave('_User') 拦截（v9 已移除 allowClientUserCreation）
  // 限流：同一 IP 窗口内超限直接拒绝（挡高频暴力破解/刷接口）
  rateLimit: [
    {
      requestPath: '/login',
      requestTimeWindow: 60000,
      requestCount: 10,
      errorResponseMessage: '登录尝试过于频繁，请 1 分钟后再试',
    },
    {
      requestPath: '/functions/register',
      requestTimeWindow: 60000,
      requestCount: 10,
      errorResponseMessage: '注册请求过于频繁，请 1 分钟后再试',
    },
    {
      requestPath: '/functions/captchaNew',
      requestTimeWindow: 60000,
      requestCount: 30,
      errorResponseMessage: '验证码请求过于频繁，请稍后再试',
    },
  ],
  // 账户锁：连续输错 5 次锁 15 分钟（挡低频字典攻击）
  accountLockout: { duration: 15, threshold: 5 },
  // 密码策略：最少 8 位（v9 用 validatorPattern 表达）
  passwordPolicy: {
    validatorPattern: '^.{8,}$',
    validationError: '密码至少 8 位',
  },
  // 文件上传大小限制 10MB
  maxUploadSize: '10mb',
  ...(ossAdapter && { filesAdapter: ossAdapter }),
});

// ---------- Express 组装（各窗口） ----------
const app = express();
app.use('/parse', parseServer.app); // Parse API
app.use('/dashboard', dashboard); // Dashboard 看板
app.get('/health', (_req, res) => res.json({ status: 'ok' })); // 健康检查

// ---------- 启动（官方推荐流程：挂载 → start() → listen） ----------
(async () => {
  // start() 会等待数据库连接、Cloud Code 加载等内部初始化完成
  await parseServer.start();

  app.listen(config.PORT, () => {
    console.log(`Parse Server running on port ${config.PORT} (${config.SERVER_URL})`);
    console.log(`Parse Dashboard at http://localhost:${config.PORT}/dashboard`);
  });

  // 启动时自动创建 Schema（幂等）
  await initSchema();
})();
