// 初始化种子数据（幂等）：
//   1. 确保默认管理员账号存在（默认用户名 xmg001；已存在同名用户则提升为管理员，保留原密码）
//   2. 存量用户回填默认角色/状态（老用户无 role/status 字段）
//   3. 写入默认菜单权限（MenuPermission 表为空时）
// 注意：只 require 纯常量模块（admin-constants.js），绝不能 require cloud/admin.js ——
//   它含 Parse.Cloud.define，在 cloud 加载器外先执行会导致 Cloud 函数注册不上
const {
  ROLE_ADMIN,
  ROLE_USER,
  STATUS_ACTIVE,
  DEFAULT_MENUS,
} = require('./cloud/admin-constants');

const config = require('./config');

async function seed() {
  const Parse = require('parse/node');
  try {
    Parse.initialize(config.APP_ID, null, config.MASTER_KEY);
  } catch {
    // 已初始化过，忽略
  }
  Parse.serverURL = config.SERVER_URL;

  // ---------- 1. 默认管理员 ----------
  // 默认管理员用户名：xmg001（可用 ADMIN_INIT_USERNAME 覆盖）
  const adminUsername = process.env.ADMIN_INIT_USERNAME || 'xmg001';
  const adminQuery = new Parse.Query(Parse.User);
  adminQuery.equalTo('username', adminUsername);
  let adminUser = await adminQuery.first({ useMasterKey: true });

  if (!adminUser) {
    // 不存在该用户：创建为管理员（密码来自 ADMIN_INIT_PASSWORD）
    const password = process.env.ADMIN_INIT_PASSWORD || 'admin123456';
    const user = new Parse.User();
    user.set('username', adminUsername);
    user.set('password', password);
    user.set('role', ROLE_ADMIN);
    user.set('status', STATUS_ACTIVE);
    try {
      await user.signUp(null, { useMasterKey: true });
      console.log(
        `[seed] 已创建默认管理员 "${adminUsername}"（密码来自 ADMIN_INIT_PASSWORD，默认 admin123456，请尽快修改）`
      );
    } catch (err) {
      console.error('[seed] 创建默认管理员失败：', err.message);
    }
  } else if (adminUser.get('role') !== ROLE_ADMIN) {
    // 已存在同名用户：提升为管理员（保留其原密码与数据）
    adminUser.set('role', ROLE_ADMIN);
    adminUser.set('status', STATUS_ACTIVE);
    try {
      await adminUser.save(null, { useMasterKey: true });
      console.log(`[seed] 已将 "${adminUsername}" 提升为管理员`);
    } catch (err) {
      console.error(`[seed] 提升 "${adminUsername}" 为管理员失败：`, err.message);
    }
  }

  // 迁移：旧 seed 创建的默认管理员 "admin"（历史产物）降级为普通用户
  // （仅当默认管理员用户名不是 "admin" 时执行，避免误伤手动创建的 admin 账号）
  if (adminUsername !== 'admin') {
    const legacyAdminQuery = new Parse.Query(Parse.User);
    legacyAdminQuery.equalTo('username', 'admin');
    legacyAdminQuery.equalTo('role', ROLE_ADMIN);
    const legacyAdmin = await legacyAdminQuery.first({ useMasterKey: true });
    if (legacyAdmin) {
      legacyAdmin.set('role', ROLE_USER);
      try {
        await legacyAdmin.save(null, { useMasterKey: true });
        console.log('[seed] 已将旧默认管理员 "admin" 降级为普通用户');
      } catch (err) {
        console.error('[seed] 降级 "admin" 失败：', err.message);
      }
    }
  }

  // ---------- 2. 存量用户回填默认角色/状态（老用户无 role/status 字段） ----------
  try {
    const legacyQuery = new Parse.Query(Parse.User);
    legacyQuery.limit(1000);
    const legacyUsers = await legacyQuery.find({ useMasterKey: true });
    let backfilled = 0;
    for (const u of legacyUsers) {
      let changed = false;
      if (!u.get('role')) {
        u.set('role', ROLE_USER);
        changed = true;
      }
      if (!u.get('status')) {
        u.set('status', STATUS_ACTIVE);
        changed = true;
      }
      if (changed) {
        await u.save(null, { useMasterKey: true });
        backfilled += 1;
      }
    }
    if (backfilled > 0) {
      console.log(`[seed] 已为 ${backfilled} 个存量用户回填默认角色/状态`);
    }
  } catch (err) {
    console.error('[seed] 存量用户回填失败：', err.message);
  }

  // ---------- 3. 默认菜单权限 ----------
  for (const role of Object.keys(DEFAULT_MENUS)) {
    const rowQuery = new Parse.Query('MenuPermission');
    rowQuery.equalTo('role', role);
    const row = await rowQuery.first({ useMasterKey: true });
    if (row) continue; // 已有配置不覆盖

    const newRow = new Parse.Object('MenuPermission');
    newRow.set('role', role);
    newRow.set('menus', DEFAULT_MENUS[role]);
    try {
      await newRow.save(null, { useMasterKey: true });
      console.log(`[seed] 已写入默认菜单权限（${role}）`);
    } catch (err) {
      console.error(`[seed] 写入菜单权限（${role}）失败：`, err.message);
    }
  }
}

module.exports = seed;
