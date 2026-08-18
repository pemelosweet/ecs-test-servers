// Cloud Code 入口：beforeSave 触发器（数据校验 + 自动补字段）+ 注册/短信 Cloud 函数
// 业务读写走 /classes REST 直连；注册走下方 register 函数（唯一建号入口）
// 第三方集成已抽离：阿里云短信见 aliyun-sms.js，图形认证见 aliyun-captcha.js
// 图床（OSS 签名直传）见 image-hosting.js
const {
  sendSmsCode,
  verifySmsCode,
  PHONE_RE,
  assertSmsDailyLimit,
  bumpSmsDailyCount,
} = require('./aliyun-sms');
const { verifyGraphicCaptcha } = require('./aliyun-captcha');
const { ROLE_USER, STATUS_ACTIVE, STATUS_DISABLED } = require('./admin-constants');
const { CAPTCHA } = require('../config');
require('./image-hosting');
require('./password-reset');
require('./admin');
require('./knowledge');
require('./knowledge-ingest');

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
// 唯一建号入口 = register 函数（master key + 安全验证）
Parse.Cloud.beforeSave('_User', (request) => {
  const user = request.object;

  if (user.isNew() && !request.master) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      '直接注册已关闭，请使用带安全验证的注册入口'
    );
  }

  // 新建用户默认角色/状态（管理员由 seed 创建时显式指定，不走默认覆盖）
  if (user.isNew()) {
    if (!user.get('role')) user.set('role', ROLE_USER);
    if (!user.get('status')) user.set('status', STATUS_ACTIVE);
  }
});

// ---------- 登录拦截：禁用账号禁止登录 ----------
Parse.Cloud.beforeLogin(async (request) => {
  const user = request.object;
  if (user && user.get('status') === STATUS_DISABLED) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, '账号已被禁用，请联系管理员');
  }
});

// ---------- 短信验证码业务入口 ----------
// 手机号校验与天级限流下沉到 aliyun-sms.js，注册与重置密码共享同一限额

// 发送短信验证码（注册流程）
Parse.Cloud.define('smsSend', async (request) => {
  const { phone } = request.params;
  if (!PHONE_RE.test(phone || '')) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '手机号格式错误');
  }

  assertSmsDailyLimit(phone);
  await sendSmsCode(phone);
  bumpSmsDailyCount(phone);
  return { ok: true };
});

// 注册：图形认证 + 短信双重验证后建号（唯一注册入口）
Parse.Cloud.define('register', async (request) => {
  const {
    username,
    password,
    email,
    phone,
    smsCode,
    lot_number,
    captcha_output,
    pass_token,
    gen_time,
  } = request.params;

  // 图形认证服务端二次校验（config.CAPTCHA.ENABLED=false 时跳过）
  if (
    CAPTCHA.ENABLED &&
    !(await verifyGraphicCaptcha({ lot_number, captcha_output, pass_token, gen_time }))
  ) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '人机验证失败，请重试');
  }

  if (!username?.trim() || !password) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '用户名和密码必填');
  }

  // 短信验证码（阿里云托管校验）
  if (!PHONE_RE.test(phone || '')) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '手机号格式错误');
  }
  if (!smsCode || !(await verifySmsCode(phone, smsCode))) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '短信验证码错误或已过期');
  }

  const user = new Parse.User();
  user.set('username', username.trim());
  user.set('password', password);
  user.set('phone', phone);
  if (email) user.set('email', email);
  // 默认普通用户 + 正常状态（beforeSave 也会兜底）
  user.set('role', ROLE_USER);
  user.set('status', STATUS_ACTIVE);
  await user.signUp(null, { useMasterKey: true });
  return { ok: true };
});
