// 阿里云图形认证服务端二次校验（号码认证服务同产品族；前端 ct4.js SDK）
// 前端验证通过后传来四要素，服务端用 appKey 对 lot_number 做 HMAC-SHA256 签名后调二次校验接口
const crypto = require('crypto');

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

module.exports = { GRAPHIC_CAPTCHA_ENABLED, verifyGraphicCaptcha };
