// Parse Dashboard 实例（与主服务同端口，挂载在 /dashboard 路径）
const ParseDashboard = require('parse-dashboard');
const config = require('./config');

module.exports = new ParseDashboard(
  {
    apps: [
      {
        serverURL: config.SERVER_URL,
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
