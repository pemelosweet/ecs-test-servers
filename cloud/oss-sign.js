// OSS 签名直传与对象校验：纯函数，不依赖 Parse，便于单元测试
const crypto = require('crypto');

// 图床支持的图片类型 → 对象 key 扩展名（白名单，服务端统一收口）
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// 图片魔数签名（文件真实内容校验，防“声明合法 content-type 直传任意内容”）
// null 表示该位置任意字节（WebP 的 RIFF size 字段）
const MAGIC_BYTES = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  'image/webp': [
    [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  ],
};

// 校验对象前若干字节是否与声明 mime 的魔数匹配
function validateImageMagic(buffer, mime) {
  const candidates = MAGIC_BYTES[mime] || [];
  if (!candidates.length) return false;
  for (const magic of candidates) {
    if (magic.length > buffer.length) continue;
    let ok = true;
    for (let i = 0; i < magic.length; i++) {
      if (magic[i] !== null && buffer[i] !== magic[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

const INLINE_DISPOSITION = 'inline';
const PUBLIC_CACHE_CONTROL = 'public,max-age=31536000,immutable';

// OSS 原生访问 host（bucket.endpoint 形式）
function normalizeHost(oss) {
  const region = oss.REGION || 'cn-beijing';
  const endpoint = oss.ENDPOINT
    ? oss.ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : `oss-${region}.aliyuncs.com`;
  return `${oss.BUCKET_NAME}.${endpoint}`;
}

// 对外访问地址：优先自定义图床域名，否则 OSS 原生域名
function publicBaseUrl(oss) {
  if (oss.PUBLIC_URL) return oss.PUBLIC_URL.replace(/\/+$/, '');
  return `https://${normalizeHost(oss)}`;
}

// 生成不可预测的对象 key：images/yyyy/MM/dd/<uuid>.<ext>
function makeObjectKey(oss, contentType) {
  const ext = ALLOWED_IMAGE_TYPES[contentType];
  if (!ext) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dir = `${oss.KEY_PREFIX || 'images'}/${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  return `${dir}/${crypto.randomUUID()}.${ext}`;
}

// 生成 PostObject policy（base64），把 key / 类型 / 大小 / 响应头全部钉死
function buildPolicy(oss, { key, contentType, expiresAt, maxSizeBytes }) {
  const policy = {
    expiration: expiresAt.toISOString(),
    conditions: [
      ['content-length-range', 1, maxSizeBytes],
      ['eq', '$key', key],
      ['eq', '$content-type', contentType],
      ['eq', '$content-disposition', INLINE_DISPOSITION],
      ['eq', '$cache-control', PUBLIC_CACHE_CONTROL],
      { bucket: oss.BUCKET_NAME },
    ],
  };
  return Buffer.from(JSON.stringify(policy)).toString('base64');
}

function signPolicy(oss, policyBase64) {
  return crypto
    .createHmac('sha1', oss.ACCESS_KEY_SECRET)
    .update(policyBase64)
    .digest('base64');
}

// OSS 原生 API 签名头（StringToSign 为 VERB + 公共头 + 资源）
function authHeader(oss, verb, date, resource) {
  const stringToSign = `${verb}\n\n\n${date}\n${resource}`;
  const signature = crypto
    .createHmac('sha1', oss.ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64');
  return `OSS ${oss.ACCESS_KEY_ID}:${signature}`;
}

// 只读校验对象已存在且元数据符合白名单（注册时防止绕过 policy 直传任意内容）
async function headObject(oss, key) {
  const host = normalizeHost(oss);
  const date = new Date().toUTCString();
  const resource = `/${oss.BUCKET_NAME}/${key}`;
  const res = await fetch(`https://${host}/${encodeURIComponent(key)}`, {
    method: 'HEAD',
    headers: { Date: date, Authorization: authHeader(oss, 'HEAD', date, resource) },
  });
  if (!res.ok) {
    throw new Error(`OSS object check failed: HTTP ${res.status}`);
  }
  return {
    contentType: String(res.headers.get('content-type') || '').split(';')[0].trim(),
    contentLength: Number(res.headers.get('content-length') || 0),
    contentDisposition: String(res.headers.get('content-disposition') || '').split(';')[0].trim(),
  };
}

// 读取对象指定字节区间（Range GET，注册时校验魔数用）
async function fetchObjectRange(oss, key, start, end) {
  const host = normalizeHost(oss);
  const date = new Date().toUTCString();
  const resource = `/${oss.BUCKET_NAME}/${key}`;
  const res = await fetch(`https://${host}/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Date: date, Authorization: authHeader(oss, 'GET', date, resource), Range: `bytes=${start}-${end}` },
  });
  if (!res.ok) {
    throw new Error(`OSS object read failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// 删除对象（404 视为已删除，幂等）
async function deleteObject(oss, key) {
  const host = normalizeHost(oss);
  const date = new Date().toUTCString();
  const resource = `/${oss.BUCKET_NAME}/${key}`;
  const res = await fetch(`https://${host}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Date: date, Authorization: authHeader(oss, 'DELETE', date, resource) },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`OSS delete failed: HTTP ${res.status}`);
  }
  return true;
}

module.exports = {
  ALLOWED_IMAGE_TYPES,
  INLINE_DISPOSITION,
  PUBLIC_CACHE_CONTROL,
  normalizeHost,
  publicBaseUrl,
  makeObjectKey,
  buildPolicy,
  signPolicy,
  headObject,
  fetchObjectRange,
  validateImageMagic,
  deleteObject,
};
