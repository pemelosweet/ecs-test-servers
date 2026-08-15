// 图床 Cloud 函数：服务端签发直传票据 → 浏览器直传 OSS → 登记 ImageAsset
// 上传凭证不落到客户端，对象 key 由服务端生成，policy 钉死类型/大小/响应头
const crypto = require('crypto');
const config = require('../config');
const {
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
} = require('./oss-sign');

const MAX_SIZE_BYTES = config.IMAGE_HOST.MAX_SIZE_MB * 1024 * 1024;
const TICKET_TTL_MS = 5 * 60 * 1000;
// 普通用户每日上传配额（张），按服务器本地自然日统计
const DAILY_UPLOAD_LIMIT = 5;

// 一次性上传票据：token -> { key, userId, expiresAt }（内存态，重启即失效，够用）
const pendingUploads = new Map();

function assertConfigured() {
  const { BUCKET_NAME, ACCESS_KEY_ID, ACCESS_KEY_SECRET } = config.OSS;
  if (!BUCKET_NAME || !ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '图床未配置：请填写 OSS 相关环境变量');
  }
}

// 今日 0 点（服务器本地自然日）
function todayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// 统计某用户今日已上传张数（以 ImageAsset 记录为准，未登记的票据不算）
async function countTodayUploads(userId) {
  const query = new Parse.Query('ImageAsset');
  query.equalTo('author', { __type: 'Pointer', className: '_User', objectId: userId });
  query.greaterThanOrEqualTo('createdAt', todayStart());
  return query.count({ useMasterKey: true });
}

// 配额校验：超限抛业务错误
async function assertDailyQuota(userId) {
  const used = await countTodayUploads(userId);
  if (used >= DAILY_UPLOAD_LIMIT) {
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      `今日上传已达上限（${DAILY_UPLOAD_LIMIT} 张），请明天再试`
    );
  }
  return used;
}

function cleanupExpiredTickets() {
  const now = Date.now();
  for (const [token, ticket] of pendingUploads) {
    if (ticket.expiresAt < now) pendingUploads.delete(token);
  }
}

function issueTicket(key, userId) {
  cleanupExpiredTickets();
  const token = crypto.randomUUID();
  pendingUploads.set(token, { key, userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return token;
}

function consumeTicket(token, key, userId) {
  const ticket = pendingUploads.get(token);
  if (!ticket || ticket.expiresAt < Date.now() || ticket.key !== key || ticket.userId !== userId) {
    if (ticket) pendingUploads.delete(token);
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '上传票据无效或已过期');
  }
  pendingUploads.delete(token);
}

// 图床外链：直连 OSS 时返回 OSS/CDN 地址；代理模式返回 Parse /files 端点（可预览）
function buildPublicFileUrl(key) {
  if (config.OSS.DIRECT_ACCESS) {
    return `${publicBaseUrl(config.OSS)}/${key}`;
  }
  return `${config.PUBLIC_SERVER_URL.replace(/\/+$/, '')}/files/${config.APP_ID}/${key}`;
}

function serialize(asset) {
  return {
    id: asset.id,
    key: asset.get('key'),
    // url 按当前配置实时推导，appId/域名变更后旧记录仍可访问
    url: buildPublicFileUrl(asset.get('key')),
    mime: asset.get('mime'),
    size: asset.get('size'),
    name: asset.get('name') || null,
    width: asset.get('width') || null,
    height: asset.get('height') || null,
    createdAt: asset.createdAt ? asset.createdAt.toISOString() : null,
    updatedAt: asset.updatedAt ? asset.updatedAt.toISOString() : null,
  };
}

// 图片记录只允许服务端（master key）登记，防止客户端伪造
Parse.Cloud.beforeSave('ImageAsset', (request) => {
  if (!request.master) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '图片记录仅允许服务端登记');
  }
});

// 1. 申请直传票据：服务端生成 key + policy + signature
Parse.Cloud.define(
  'imageHostUploadTicket',
  async (request) => {
    assertConfigured();
    // 配额校验（未上传前拦截，最省流量）
    await assertDailyQuota(request.user.id);

    const contentType = String(request.params.contentType || '').split(';')[0].trim();
    if (!ALLOWED_IMAGE_TYPES[contentType]) {
      throw new Parse.Error(
        Parse.Error.VALIDATION_ERROR,
        `仅支持 ${Object.keys(ALLOWED_IMAGE_TYPES).join(' / ')}`
      );
    }

    const key = makeObjectKey(config.OSS, contentType);
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    const policy = buildPolicy(config.OSS, {
      key,
      contentType,
      expiresAt,
      maxSizeBytes: MAX_SIZE_BYTES,
    });

    return {
      uploadUrl: `https://${normalizeHost(config.OSS)}`,
      key,
      token: issueTicket(key, request.user.id),
      accessKeyId: config.OSS.ACCESS_KEY_ID,
      policy,
      signature: signPolicy(config.OSS, policy),
      contentType,
      contentDisposition: INLINE_DISPOSITION,
      cacheControl: PUBLIC_CACHE_CONTROL,
      url: buildPublicFileUrl(key),
      maxSize: MAX_SIZE_BYTES,
      // 下发白名单与上限，前端用服务端值校验（单一事实源，不再硬编码）
      allowedTypes: Object.keys(ALLOWED_IMAGE_TYPES),
      quota: { limit: DAILY_UPLOAD_LIMIT },
      expiresAt: expiresAt.toISOString(),
    };
  },
  { requireUser: true }
);

// 2. 直传完成后登记：校验对象元数据 + 魔数，写 ImageAsset
Parse.Cloud.define(
  'imageHostRegister',
  async (request) => {
    assertConfigured();
    const { key, token, name, width, height } = request.params || {};
    if (!key || !token) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '缺少 key 或 token');
    }
    consumeTicket(token, key, request.user.id);

    // 配额二次校验（防并发绕过 ticket 阶段检查）
    await assertDailyQuota(request.user.id);

    const head = await headObject(config.OSS, key);
    if (!ALLOWED_IMAGE_TYPES[head.contentType]) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '对象类型不在图床白名单内');
    }
    if (head.contentDisposition !== INLINE_DISPOSITION) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '对象响应头异常，请重新上传');
    }
    if (head.contentLength > MAX_SIZE_BYTES) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '图片超过大小上限');
    }
    // 魔数校验：真实内容必须与声明的图片类型一致（防伪图片混入）
    try {
      const headBytes = await fetchObjectRange(config.OSS, key, 0, 15);
      if (!validateImageMagic(headBytes, head.contentType)) {
        throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '图片内容校验失败，请重新上传');
      }
    } catch (err) {
      if (err instanceof Parse.Error) throw err;
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '图片内容校验失败，请稍后重试');
    }

    const existing = await new Parse.Query('ImageAsset')
      .equalTo('key', key)
      .first({ useMasterKey: true });
    if (existing) {
      return serialize(existing);
    }

    const asset = new Parse.Object('ImageAsset');
    asset.set('key', key);
    asset.set('url', buildPublicFileUrl(key));
    asset.set('mime', head.contentType);
    asset.set('size', head.contentLength);
    asset.set('author', request.user);
    // 原始文件名 + 前端读取的宽高（展示用，缺失不阻断登记）
    if (name) asset.set('name', String(name).slice(0, 255));
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);
    if (w > 0) asset.set('width', w);
    if (h > 0) asset.set('height', h);
    await asset.save(null, { useMasterKey: true });
    return serialize(asset);
  },
  { requireUser: true }
);

// 3. 图床列表（倒序分页 + 名称/日期过滤，total 供前端分页组件；需登录）
Parse.Cloud.define(
  'imageHostList',
  async (request) => {
    const limit = Math.min(Math.max(parseInt(request.params?.limit, 10) || 20, 1), 100);
    const skip = Math.max(parseInt(request.params?.skip, 10) || 0, 0);
    const { name, startDate, endDate } = request.params || {};
    let query = new Parse.Query('ImageAsset');
    if (name?.trim()) {
      const kw = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 新记录按原始文件名匹配，兼容无 name 的旧记录按 key 匹配；不区分大小写
      query = Parse.Query.or(
        new Parse.Query('ImageAsset').matches('name', new RegExp(kw, 'i')),
        new Parse.Query('ImageAsset').matches('key', new RegExp(kw, 'i'))
      );
    }
    query.descending('createdAt');
    query.limit(limit);
    query.skip(skip);
    if (startDate) query.greaterThanOrEqualTo('createdAt', new Date(startDate));
    if (endDate) query.lessThanOrEqualTo('createdAt', new Date(endDate));
    const [results, total] = await Promise.all([
      query.find({ useMasterKey: true }),
      query.count({ useMasterKey: true }),
    ]);
    // 附带今日配额（页面顶部展示）
    const quota = {
      used: await countTodayUploads(request.user.id),
      limit: DAILY_UPLOAD_LIMIT,
    };
    return { results: results.map(serialize), total, quota };
  },
  { requireUser: true }
);

// 4. 删除：仅作者本人可删，OSS 对象 + 记录同步清理
Parse.Cloud.define(
  'imageHostDelete',
  async (request) => {
    assertConfigured();
    const asset = await new Parse.Query('ImageAsset').get(request.params.id, {
      useMasterKey: true,
    });
    const owner = asset.get('author');
    if (!request.master && (!owner || owner.id !== request.user.id)) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '只能删除自己上传的图片');
    }
    await deleteObject(config.OSS, asset.get('key'));
    await asset.destroy({ useMasterKey: true });
    return { ok: true };
  },
  { requireUser: true }
);
