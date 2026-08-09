// pm2 启动配置（生产环境常驻进程）
// 用法：pm2 start ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'parse-server',
      script: 'index.js',
      // 生产模式：禁止客户端随意建 class 等
      env: {
        NODE_ENV: 'production',
      },
      // 内存超限自动重启，防泄漏
      max_memory_restart: '500M',
      // 日志带时间戳
      time: true,
      // 崩溃自动重启
      autorestart: true,
    },
  ],
};
