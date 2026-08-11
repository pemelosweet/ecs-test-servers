// Cloud Code：beforeSave 触发器（数据校验 + 自动补字段）
// 业务读写走 /classes REST 直连；注册走下方 register 函数（唯一建号入口）
const crypto = require('crypto');
const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
// SDK 主类挂在 .default 上（官方示例同款写法），请求类是命名导出
const DypnsClient = Dypnsapi20170525.default;
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');

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

// ---------- 图形认证（阿里云号码认证服务，与短信同产品族；前端 ct4.js SDK） ----------
// 前端验证通过后传来四要素，服务端用 appKey 对 lot_number 做 HMAC-SHA256 签名后调二次校验接口
// 开关：临时停用图形认证（false），恢复时置 true 并同步前端 RegisterPage 的 GRAPHIC_CAPTCHA_ENABLED
const GRAPHIC_CAPTCHA_ENABLED = false;
const GRAPHIC_VALIDATE_URL = 'https://captcha.alicaptcha.com/validate';

async function verifyGraphicCaptcha({ lot_number, captcha_output, pass_token, gen_time }) {
  const { GRAPHIC_CAPTCHA_APP_ID, GRAPHIC_CAPTCHA_APP_KEY } = process.env;
  if (!GRAPHIC_CAPTCHA_APP_ID || !GRAPHIC_CAPTCHA_APP_KEY) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      '图形认证未配置：.env 缺少 GRAPHIC_CAPTCHA_APP_ID / GRAPHIC_CAPTCHA_APP_KEY'
    );
  }
  if (!lot_number || !captcha_output || !pass_token || !gen_time) return false;

  const sign_token = crypto
    .createHmac('sha256', GRAPHIC_CAPTCHA_APP_KEY)
    .update(lot_number)
    .digest('hex');
  try {
    const res = await fetch(`${GRAPHIC_VALIDATE_URL}?captcha_id=${GRAPHIC_CAPTCHA_APP_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        lot_number,
        captcha_output,
        pass_token,
        gen_time,
        sign_token,
      }),
    });
    // 官方建议：二次校验接口异常时不阻断业务（放行），防验证服务故障拖垮注册
    if (res.status !== 200) return true;
    const msg = await res.json();
    return msg.result === 'success';
  } catch (err) {
    console.error('[graphic-captcha] 二次校验请求异常，放行：', err.message);
    return true;
  }
}

// ---------- 短信验证码（阿里云号码认证服务 dypnsapi） ----------
// 验证码由阿里云生成并托管校验（##code## + CheckSmsVerifyCode），本端不存码；
// 发送间隔（60s）、有效期（300s）、旧码覆盖均由阿里云侧控制
const PHONE_RE = /^1\d{10}$/;

let _smsClient = null;
function getSmsClient() {
  if (!_smsClient) {
    const { ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET } = process.env;
    if (!ALIBABA_CLOUD_ACCESS_KEY_ID || !ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        '短信服务未配置：.env 缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET'
      );
    }
    _smsClient = new DypnsClient(
      new OpenApi.Config({
        accessKeyId: ALIBABA_CLOUD_ACCESS_KEY_ID,
        accessKeySecret: ALIBABA_CLOUD_ACCESS_KEY_SECRET,
        endpoint: 'dypnsapi.aliyuncs.com',
      })
    );
  }
  return _smsClient;
}

// 阿里云错误码 → 中文文案（SDK 抛出的 code 带 isv. 前缀，映射前剥掉）
const SMS_ERROR_MAP = {
  MOBILE_NUMBER_ILLEGAL: '手机号格式错误',
  BUSINESS_LIMIT_CONTROL: '该号码今日发送次数已达上限，请明天再试',
  FREQUENCY_FAIL: '发送过于频繁，请 1 分钟后再试',
  INVALID_PARAMETERS: '短信参数配置有误，请联系管理员',
  FUNCTION_NOT_OPENED: '号码认证服务未开通，请到阿里云控制台开通',
  VALIDATE_FAIL: '短信验证码错误或已过期',
};
function translateSmsError(err) {
  const raw = err.code || err.data?.Code || '';
  const code = raw.replace(/^isv\./, '');
  if (!SMS_ERROR_MAP[code]) {
    console.error('[sms] 未映射的阿里云错误：', raw, err.message);
  }
  return new Parse.Error(
    Parse.Error.VALIDATION_ERROR,
    SMS_ERROR_MAP[code] || '短信发送失败，请稍后重试'
  );
}

// 同号码天级发送上限（叠加阿里云自身流控，防换号轰炸）；内存记录，重启清零
const smsDailyCount = new Map(); // phone -> { day, count }
const SMS_DAILY_LIMIT = 10;

// 发送短信验证码
Parse.Cloud.define('smsSend', async (request) => {
  const { phone } = request.params;
  if (!PHONE_RE.test(phone || '')) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '手机号格式错误');
  }

  const day = new Date().toISOString().slice(0, 10);
  const rec = smsDailyCount.get(phone);
  if (rec && rec.day === day && rec.count >= SMS_DAILY_LIMIT) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '该号码今日发送次数已达上限，请明天再试');
  }

  const params = {
    phoneNumber: phone,
    signName: process.env.SMS_SIGN_NAME,
    templateCode: process.env.SMS_TEMPLATE_CODE,
    // ##code## = 由阿里云生成验证码，后续可用 CheckSmsVerifyCode 托管校验
    templateParam: JSON.stringify({ code: '##code##', min: '5' }),
    codeLength: 6,
    codeType: 1, // 纯数字
    validTime: 300,
    interval: 60, // 同号码 60 秒内只能发一次
    duplicatePolicy: 1, // 重发时旧码失效
  };
  if (process.env.SMS_SCHEME_NAME) params.schemeName = process.env.SMS_SCHEME_NAME;

  try {
    const resp = await getSmsClient().sendSmsVerifyCodeWithOptions(
      new Dypnsapi20170525.SendSmsVerifyCodeRequest(params),
      new Util.RuntimeOptions({})
    );
    if (resp.body?.code !== 'OK') {
      throw Object.assign(new Error(resp.body?.message), { code: resp.body?.code });
    }
  } catch (err) {
    throw translateSmsError(err);
  }

  smsDailyCount.set(phone, { day, count: rec && rec.day === day ? rec.count + 1 : 1 });
  return { ok: true };
});

// 阿里云托管校验短信验证码（仅 ##code## 方式可用）
async function verifySmsCode(phone, smsCode) {
  const params = { phoneNumber: phone, verifyCode: smsCode };
  if (process.env.SMS_SCHEME_NAME) params.schemeName = process.env.SMS_SCHEME_NAME;
  try {
    const resp = await getSmsClient().checkSmsVerifyCodeWithOptions(
      new Dypnsapi20170525.CheckSmsVerifyCodeRequest(params),
      new Util.RuntimeOptions({})
    );
    // 接口请求成功 ≠ 核验通过，以 Model.VerifyResult 为准
    return resp.body?.model?.verifyResult === 'PASS';
  } catch (err) {
    throw translateSmsError(err);
  }
}

// 注册：图形认证 + 短信双重验证后建号（allowClientUserCreation=false 后的唯一注册入口）
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

  // 图形认证服务端二次校验
  if (!(await verifyGraphicCaptcha({ lot_number, captcha_output, pass_token, gen_time }))) {
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
  await user.signUp(null, { useMasterKey: true });
  return { ok: true };
});
