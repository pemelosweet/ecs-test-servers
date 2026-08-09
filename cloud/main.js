// Cloud Code：beforeSave 触发器（数据校验 + 自动补字段）
// 业务读写走 /classes REST 直连；注册走下方 register 函数（唯一建号入口）
const crypto = require('crypto');

// Org 保存前：校验组织名称 + 自动记录作者
Parse.Cloud.beforeSave('Org', (request) => {
  const org = request.object;

  if (!org.get('orgName')?.trim()) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '组织名称不能为空');
  }

  // 新建时自动记录提交人（update 时不覆盖）
  if (org.isNew() && !org.get('author')) {
    org.set('author', request.user);
  }
});

// Profile 保存前：校验姓名 + 自动记录作者
Parse.Cloud.beforeSave('Profile', (request) => {
  const profile = request.object;

  if (!profile.get('name')?.trim()) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '姓名不能为空');
  }

  // 新建时自动记录提交人（update 时不覆盖）
  if (profile.isNew() && !profile.get('author')) {
    profile.set('author', request.user);
  }
});

// ---------- 注册入口收口 ----------
// v9 已移除 allowClientUserCreation：用 beforeSave 拦截非 master key 的新建用户，
// 唯一建号入口 = register 函数（master key + 滑块校验）
Parse.Cloud.beforeSave('_User', (request) => {
  if (request.object.isNew() && !request.master) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      '直接注册已关闭，请使用带安全验证的注册入口'
    );
  }
});

// ---------- 滑块验证码（轻量自研版：挡脚本，不挡人） ----------
// 内存存储 captchaId -> { x, expiresAt }；一次性使用，5 分钟过期
const captchaStore = new Map();
const CAPTCHA_TTL = 5 * 60 * 1000;
const CAPTCHA_TOLERANCE = 6; // 像素容差

// 每分钟清理过期项，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of captchaStore) {
    if (item.expiresAt < now) captchaStore.delete(id);
  }
}, 60 * 1000).unref();

// 生成带缺口背景图（SVG）：缺口位置即目标 x
function buildSvg(width, height, x, y, size) {
  const hue = Math.floor(Math.random() * 360);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},60%,70%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 80) % 360},60%,55%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
    `<circle cx="${Math.round(width * 0.25)}" cy="${Math.round(height * 0.3)}" r="18" fill="rgba(255,255,255,.25)"/>` +
    `<circle cx="${Math.round(width * 0.7)}" cy="${Math.round(height * 0.7)}" r="26" fill="rgba(0,0,0,.15)"/>` +
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>` +
    `</svg>`
  );
}

// 下发滑块验证码
Parse.Cloud.define('captchaNew', () => {
  const width = 300;
  const height = 100;
  const size = 40;
  const x = 60 + Math.floor(Math.random() * (width - size - 80));
  const y = 20 + Math.floor(Math.random() * (height - size - 40));
  const captchaId = crypto.randomUUID();
  captchaStore.set(captchaId, { x, expiresAt: Date.now() + CAPTCHA_TTL });
  return { captchaId, svg: buildSvg(width, height, x, y, size), width, height, pieceSize: size, y };
});

// 注册：先验滑块再建号（allowClientUserCreation=false 后的唯一注册入口）
Parse.Cloud.define('register', async (request) => {
  const { username, password, email, captchaId, x } = request.params;

  // 验证码一次性：先取出即销毁，防止重试攻击
  const item = captchaStore.get(captchaId);
  captchaStore.delete(captchaId);
  if (!item || item.expiresAt < Date.now()) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '验证码已过期，请刷新重试');
  }
  if (typeof x !== 'number' || Math.abs(x - item.x) > CAPTCHA_TOLERANCE) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '滑块验证失败，请重试');
  }

  if (!username?.trim() || !password) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '用户名和密码必填');
  }

  const user = new Parse.User();
  user.set('username', username.trim());
  user.set('password', password);
  if (email) user.set('email', email);
  await user.signUp(null, { useMasterKey: true });
  return { ok: true };
});
