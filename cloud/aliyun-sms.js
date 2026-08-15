// 阿里云号码认证服务（dypnsapi）短信验证码封装
// Parse 全局由 Parse Server cloud code 运行环境注入，本文件由 cloud/main.js require 加载
// 验证码由阿里云生成并托管校验（##code## + CheckSmsVerifyCode），本端不存码；
// 发送间隔（60s）、有效期（300s）、旧码覆盖均由阿里云侧控制
const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');
const config = require('../config');

// SDK 主类挂在 .default 上（官方示例同款写法），请求类是命名导出
const DypnsClient = Dypnsapi20170525.default;

let _smsClient = null;
function getSmsClient() {
  if (!_smsClient) {
    const { ACCESS_KEY_ID, ACCESS_KEY_SECRET, ENDPOINT } = config.SMS;
    if (!ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        '短信服务未配置：.env 缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET'
      );
    }
    _smsClient = new DypnsClient(
      new OpenApi.Config({
        accessKeyId: ACCESS_KEY_ID,
        accessKeySecret: ACCESS_KEY_SECRET,
        endpoint: ENDPOINT,
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
  // err.code 可能是字符串/数字/对象，统一转字符串；剥 isv. 前缀，驼峰转 UNDERSCORE 大写（实际返回如 ValidateFail → VALIDATE_FAIL）
  const raw = String(err.code ?? err.data?.Code ?? '');
  const code = raw
    .replace(/^isv\./, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase();
  if (!SMS_ERROR_MAP[code]) {
    console.error('[sms] 未映射的阿里云错误：', raw, err.message, JSON.stringify(err.data || {}));
  }
  return new Parse.Error(
    Parse.Error.VALIDATION_ERROR,
    SMS_ERROR_MAP[code] || '短信发送失败，请稍后重试'
  );
}

// 发送短信验证码（##code## 由阿里云生码）
async function sendSmsCode(phone) {
  const params = {
    phoneNumber: phone,
    signName: config.SMS.SIGN_NAME,
    templateCode: config.SMS.TEMPLATE_CODE,
    // ##code## = 由阿里云生成验证码，后续可用 CheckSmsVerifyCode 托管校验
    templateParam: JSON.stringify({ code: '##code##', min: '5' }),
    codeLength: 6,
    codeType: 1, // 纯数字
    validTime: 300,
    interval: 60, // 同号码 60 秒内只能发一次
    duplicatePolicy: 1, // 重发时旧码失效
  };
  if (config.SMS.SCHEME_NAME) params.schemeName = config.SMS.SCHEME_NAME;

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
}

// 阿里云托管校验短信验证码（仅 ##code## 方式可用）
async function verifySmsCode(phone, smsCode) {
  const params = { phoneNumber: phone, verifyCode: smsCode };
  if (config.SMS.SCHEME_NAME) params.schemeName = config.SMS.SCHEME_NAME;
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

// 手机号格式（中国大陆 11 位）
const PHONE_RE = /^1\d{10}$/;

// ---------- 业务流控：同号码天级发送上限 ----------
// 内存记录，重启清零；各短信入口（注册 smsSend / 重置密码）共用，防交替调用绕过
const smsDailyCount = new Map(); // phone -> { day, count }
const SMS_DAILY_LIMIT = 10;

// 超限抛错（发送前调用）
function assertSmsDailyLimit(phone) {
  const day = new Date().toISOString().slice(0, 10);
  const rec = smsDailyCount.get(phone);
  if (rec && rec.day === day && rec.count >= SMS_DAILY_LIMIT) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '该号码今日发送次数已达上限，请明天再试');
  }
}

// 发送成功后计数（叠加阿里云自身流控）
function bumpSmsDailyCount(phone) {
  const day = new Date().toISOString().slice(0, 10);
  const rec = smsDailyCount.get(phone);
  smsDailyCount.set(phone, { day, count: rec && rec.day === day ? rec.count + 1 : 1 });
}

module.exports = {
  sendSmsCode,
  verifySmsCode,
  PHONE_RE,
  assertSmsDailyLimit,
  bumpSmsDailyCount,
};
