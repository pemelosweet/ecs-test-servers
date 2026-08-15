// 后台管理 Cloud 函数：用户管理 + 菜单权限管理
// 全部函数仅管理员可调用（assertAdmin），服务端逻辑用 master key 绕过 _User CLP
// 数据模型：
//   _User.role    → 'admin' | 'user'（默认 user，注册时写入）
//   _User.status  → 'active' | 'disabled'（默认 active；disabled 禁止登录，见 main.js beforeLogin）
//   MenuPermission → { role: String, menus: Array } 每角色一行，存该角色可访问的菜单 key 列表
const {
  ROLE_ADMIN,
  ROLE_USER,
  STATUS_ACTIVE,
  STATUS_DISABLED,
  LOCKED_MENUS,
  ADMIN_ONLY_MENUS,
  DEFAULT_MENUS,
} = require('./admin-constants');
const config = require('../config');
const { deleteObject } = require('./oss-sign');

// 删除用户时联动清理其图床数据：OSS 对象尽力删除（OSS 未配置/删除失败不阻断用户删除），记录同步移除
async function destroyUserImageAssets(user) {
  const query = new Parse.Query('ImageAsset');
  query.equalTo('author', user);
  query.limit(1000);
  const assets = await query.find({ useMasterKey: true });
  if (!assets.length) return;

  const { BUCKET_NAME, ACCESS_KEY_ID, ACCESS_KEY_SECRET } = config.OSS;
  const ossConfigured = BUCKET_NAME && ACCESS_KEY_ID && ACCESS_KEY_SECRET;
  for (const asset of assets) {
    const key = asset.get('key');
    if (ossConfigured && key) {
      try {
        await deleteObject(config.OSS, key);
      } catch (err) {
        console.warn(`[admin] 清理用户图床对象失败（跳过）：${key}`, err.message);
      }
    }
  }
  await Parse.Object.destroyAll(assets, { useMasterKey: true });
}

// 仅管理员可调用：非 master key 场景校验当前登录用户角色
function assertAdmin(request) {
  if (request.master) return;
  const user = request.user;
  if (!user || user.get('role') !== ROLE_ADMIN) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '仅管理员可执行此操作');
  }
}

// 普通用户永不可拥有管理员专属菜单（无论存量数据如何，一律剔除）
function sanitizeUserMenus(menus) {
  return menus.filter((m) => !ADMIN_ONLY_MENUS.includes(m));
}

// 查询目标用户（master key），不存在则报错
async function findUserById(userId) {
  const query = new Parse.Query(Parse.User);
  const user = await query.get(userId, { useMasterKey: true });
  return user;
}

// 删除指定用户的所有会话（禁用/删除时吊销登录态）
async function destroyUserSessions(user) {
  const sessionQuery = new Parse.Query(Parse.Session);
  sessionQuery.equalTo('user', user);
  const sessions = await sessionQuery.find({ useMasterKey: true });
  if (sessions.length) {
    await Parse.Object.destroyAll(sessions, { useMasterKey: true });
  }
}

// ---------- 用户列表（分页 + 用户名/角色/状态搜索） ----------
// 参数：{ page, pageSize, username, role, status }
// 返回：{ list: [{ id, username, role, status, createdAt }], total }
Parse.Cloud.define('adminUserList', async (request) => {
  assertAdmin(request);

  const page = Math.max(parseInt(request.params.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(request.params.pageSize, 10) || 10, 1), 100);
  const { username, role, status } = request.params || {};

  const query = new Parse.Query(Parse.User);
  if (username?.trim()) {
    const escaped = String(username).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.matches('username', new RegExp(escaped, 'i'));
  }
  if (role && role !== 'all') {
    query.equalTo('role', role);
  }
  if (status && status !== 'all') {
    query.equalTo('status', status);
  }

  query.descending('createdAt');
  const total = await query.count({ useMasterKey: true });
  query.skip((page - 1) * pageSize);
  query.limit(pageSize);

  const users = await query.find({ useMasterKey: true });
  const list = users.map((u) => ({
    id: u.id,
    username: u.get('username'),
    role: u.get('role') || ROLE_USER,
    status: u.get('status') || STATUS_ACTIVE,
    createdAt: u.get('createdAt') ? u.get('createdAt').toISOString() : null,
  }));

  return { list, total, page, pageSize };
});

// ---------- 禁用 / 启用用户 ----------
// 参数：{ userId, status: 'active' | 'disabled' }
// 禁用后禁止登录（beforeLogin 拦截），并立即吊销该账号所有会话
Parse.Cloud.define('adminSetUserStatus', async (request) => {
  assertAdmin(request);

  const { userId, status } = request.params || {};
  if (!userId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '缺少用户 ID');
  }
  if (status !== STATUS_ACTIVE && status !== STATUS_DISABLED) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '状态参数不合法');
  }

  const target = await findUserById(userId);
  if (request.user && target.id === request.user.id) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '不能操作当前登录账号');
  }
  if (target.get('role') === ROLE_ADMIN) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '管理员账户不可禁用');
  }

  target.set('status', status);
  await target.save(null, { useMasterKey: true });

  if (status === STATUS_DISABLED) {
    await destroyUserSessions(target); // 立即踢下线
  }
  return { ok: true, id: target.id, status };
});

// ---------- 删除用户（完全移除） ----------
// 连带删除：该用户的 Profile 档案 + 全部会话（用户对象本身彻底销毁）
Parse.Cloud.define('adminDeleteUser', async (request) => {
  assertAdmin(request);

  const { userId } = request.params || {};
  if (!userId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '缺少用户 ID');
  }

  const target = await findUserById(userId);
  if (request.user && target.id === request.user.id) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '不能删除当前登录账号');
  }
  if (target.get('role') === ROLE_ADMIN) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '管理员账户不可删除');
  }

  // 删除该用户的个人档案（author 指向该用户）
  const profileQuery = new Parse.Query('Profile');
  profileQuery.equalTo('author', target);
  const profiles = await profileQuery.find({ useMasterKey: true });
  if (profiles.length) {
    await Parse.Object.destroyAll(profiles, { useMasterKey: true });
  }

  // 联动清理该用户的图床数据（OSS 对象 + ImageAsset 记录）
  await destroyUserImageAssets(target);

  await destroyUserSessions(target);
  await target.destroy({ useMasterKey: true });

  return { ok: true, id: userId };
});

// ---------- 读取 MenuPermission 行（按角色），无记录时返回默认 ----------
async function readMenuPermissionRow(role) {
  const query = new Parse.Query('MenuPermission');
  query.equalTo('role', role);
  const row = await query.first({ useMasterKey: true });
  if (row) {
    return (row.get('menus') || []).filter(Boolean);
  }
  return DEFAULT_MENUS[role] ? [...DEFAULT_MENUS[role]] : [];
}

// 写入 MenuPermission 行（不存在则创建）
async function writeMenuPermissionRow(role, menus) {
  const query = new Parse.Query('MenuPermission');
  query.equalTo('role', role);
  let row = await query.first({ useMasterKey: true });
  if (!row) {
    row = new Parse.Object('MenuPermission');
    row.set('role', role);
  }
  row.set('menus', menus);
  await row.save(null, { useMasterKey: true });
}

// ---------- 当前登录用户可访问的菜单 ----------
// 返回：{ role, menus }（登录即可调用）
Parse.Cloud.define('getMenuPermissions', async (request) => {
  const user = request.user;
  if (!user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, '未登录');
  }
  const role = user.get('role') === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
  let menus = await readMenuPermissionRow(role);

  // 管理员兜底：锁定菜单永远放行
  if (role === ROLE_ADMIN) {
    for (const key of LOCKED_MENUS) {
      if (!menus.includes(key)) menus.push(key);
    }
  } else {
    // 普通用户：管理员专属菜单永不可拥有（防御存量脏数据）
    menus = sanitizeUserMenus(menus);
  }
  // 空配置时回退默认
  if (!menus.length) {
    menus = DEFAULT_MENUS[role] ? [...DEFAULT_MENUS[role]] : [];
  }
  return { role, menus };
});

// ---------- 读取全部角色菜单权限（权限管理页用，仅管理员） ----------
Parse.Cloud.define('adminGetMenuPermissions', async (request) => {
  assertAdmin(request);
  const userMenus = sanitizeUserMenus(await readMenuPermissionRow(ROLE_USER));
  let adminMenus = await readMenuPermissionRow(ROLE_ADMIN);
  for (const key of LOCKED_MENUS) {
    if (!adminMenus.includes(key)) adminMenus.push(key);
  }
  if (!userMenus.length) userMenus.push(...DEFAULT_MENUS.user);
  if (!adminMenus.length) adminMenus.push(...DEFAULT_MENUS.admin);
  return {
    user: userMenus,
    admin: adminMenus,
    locked: LOCKED_MENUS,
  };
});

// ---------- 保存菜单权限（仅管理员） ----------
// 参数：{ permissions: { user: [...], admin: [...] } }
// 管理员锁定菜单强制保留；普通用户永不可勾选管理员专属菜单（服务端强制剔除，客户端不可绕过）
Parse.Cloud.define('adminUpdateMenuPermissions', async (request) => {
  assertAdmin(request);

  const { permissions } = request.params || {};
  if (!permissions || typeof permissions !== 'object') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '参数不合法');
  }

  let userMenus = Array.isArray(permissions.user) ? permissions.user.filter(Boolean) : [];
  let adminMenus = Array.isArray(permissions.admin) ? permissions.admin.filter(Boolean) : [];

  // 普通用户强制剔除管理员专属菜单
  userMenus = sanitizeUserMenus(userMenus);

  // 管理员锁定菜单强制勾选
  for (const key of LOCKED_MENUS) {
    if (!adminMenus.includes(key)) adminMenus.push(key);
  }

  // 空数组不落库（避免全空导致系统无菜单），回退默认
  const finalUser = userMenus.length ? userMenus : [...DEFAULT_MENUS.user];
  const finalAdmin = adminMenus.length ? adminMenus : [...DEFAULT_MENUS.admin];

  await writeMenuPermissionRow(ROLE_USER, finalUser);
  await writeMenuPermissionRow(ROLE_ADMIN, finalAdmin);

  return { ok: true, user: finalUser, admin: finalAdmin };
});
