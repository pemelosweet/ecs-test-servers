// Parse Dashboard 实例（与主服务同端口，挂载在 /dashboard 路径）
const ParseDashboard = require('parse-dashboard');
const config = require('./config');

module.exports = new ParseDashboard(
  {
    apps: [
      {
        // 看板由浏览器直连 serverURL，必须用对外可达地址（PUBLIC_SERVER_URL），而非服务端内部地址
        serverURL: process.env.PUBLIC_SERVER_URL || config.SERVER_URL,
        appId: config.APP_ID,
        masterKey: config.MASTER_KEY,
        appName: 'ECS Backend',
      },
    ],
    users: [
      {
        user: config.DASHBOARD_USER,
        pass: config.DASHBOARD_PASSWORD,
      },
    ],
  },
  { allowInsecureHTTP: !config.IS_PRODUCTION }
);
