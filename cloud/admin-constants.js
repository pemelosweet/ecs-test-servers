// 权限相关纯常量：独立成文件，避免在 Parse Cloud 加载器之外 require admin.js
// （seed.js 在服务启动前 require，若直接引用 admin.js 会导致其模块体在 cloud 上下文外先执行一次，
//   从而被 require 缓存，Cloud 函数注册不到 Parse Server）

const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';
const STATUS_ACTIVE = 'active';
const STATUS_DISABLED = 'disabled';

// 管理员专属（锁定）菜单：对管理员默认勾选且禁止取消，对普通用户永不可勾选/不可拥有
// 前后端保持一致（前端见 menuConfig.jsx 的 ADMIN_LOCKED_MENUS）
const LOCKED_MENUS = ['/permissions', '/users'];
// 语义别名：管理员专属菜单（普通用户不可拥有）
const ADMIN_ONLY_MENUS = LOCKED_MENUS;

// 默认菜单权限（MenuPermission 无数据时兜底；新增菜单需同步 menuConfig.jsx）
const DEFAULT_MENUS = {
  admin: ['/home', '/org', '/profile', '/images', '/knowledge', '/users', '/permissions'],
  user: ['/home', '/org', '/profile', '/images', '/knowledge'],
};

module.exports = {
  ROLE_ADMIN,
  ROLE_USER,
  STATUS_ACTIVE,
  STATUS_DISABLED,
  LOCKED_MENUS,
  ADMIN_ONLY_MENUS,
  DEFAULT_MENUS,
};
