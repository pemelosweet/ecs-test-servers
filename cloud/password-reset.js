// 重置密码（忘记密码）：短信验证码方案
// resetPasswordSmsSend：username + phone 双条件匹配才发码（防止对任意号码刷短信）
// resetPassword：定位用户 → 校验验证码 → master key 改密 + 吊销该账号全部会话
// 复用 aliyun-sms.js 的收发与共享天级限流（与注册 smsSend 同一限额，防交替调用绕过）
const {
  sendSmsCode,
  verifySmsCode,
  PHONE_RE,
  assertSmsDailyLimit,
  bumpSmsDailyCount,
} = require('./aliyun-sms');

// username + phone 双条件查用户（master key 绕过 _User CLP），不存在返回 null
async function findUserByAccount(username, phone) {
  const query = new Parse.Query(Parse.User);
  query.equalTo('username', username.trim());
  query.equalTo('phone', phone);
  return query.first({ useMasterKey: true });
}

// 第一步：发送重置验证码（先查人再发码，避免为不存在的账号消耗验证码）
Parse.Cloud.define('resetPasswordSmsSend', async (request) => {
  const { username, phone } = request.params || {};
  if (!username?.trim() || !PHONE_RE.test(phone || '')) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '请正确输入用户名和手机号');
  }

  const user = await findUserByAccount(username, phone);
  if (!user) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '用户名与手机号不匹配');
  }

  assertSmsDailyLimit(phone);
  await sendSmsCode(phone);
  bumpSmsDailyCount(phone);
  return { ok: true };
});

// 第二步：校验验证码并设置新密码
Parse.Cloud.define('resetPassword', async (request) => {
  const { username, phone, smsCode, newPassword } = request.params || {};
  if (!username?.trim() || !PHONE_RE.test(phone || '') || !smsCode || !newPassword) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '参数不完整');
  }

  const user = await findUserByAccount(username, phone);
  if (!user) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '用户名与手机号不匹配');
  }

  // 阿里云托管校验（码 5 分钟有效，校验通过后旧码即失效）
  if (!(await verifySmsCode(phone, smsCode))) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '短信验证码错误或已过期');
  }

  // 密码至少 8 位（与 index.js passwordPolicy 一致，提前拦截给出中文提示）
  if (String(newPassword).length < 8) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '密码至少 8 位');
  }

  user.set('password', newPassword);
  await user.save(null, { useMasterKey: true });

  // 改密后全部旧登录态作废：删除该账号所有 Session（强制重新登录）
  const sessionQuery = new Parse.Query(Parse.Session);
  sessionQuery.equalTo('user', user);
  const sessions = await sessionQuery.find({ useMasterKey: true });
  if (sessions.length) {
    await Parse.Object.destroyAll(sessions, { useMasterKey: true });
  }

  return { ok: true };
});
