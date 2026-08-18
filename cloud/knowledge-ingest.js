// 知识库文档管理 Cloud 函数：上传（解析 + 切块 + 向量化入库）/ 列表 / 删除
// 向量链路：chunk 原文存 MongoDB（Chunk），向量存 Qdrant（chunkId 关联，见 qdrant.js toUuid）
const { parseDocument, chunkText } = require('./doc-parser');
const { embedBatch } = require('./embedding');
const { upsertPoints, deleteByDocument } = require('./qdrant');
const { ROLE_ADMIN } = require('./admin-constants');

// 从 request.params 解析文件 URL 与标题
function resolveFile(params) {
  const f = params?.file;
  if (!f) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '缺少文件');
  // file 可能是 Parse.File 实例（url() 方法）或序列化对象（url 属性）
  const url = typeof f === 'string' ? f : typeof f.url === 'function' ? f.url() : f.url;
  const title = params?.title?.trim() || (typeof f === 'object' ? f.name : '') || '未命名文档';
  if (!url) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '文件 URL 无效');
  return { url, title };
}

// 1. 上传：下载文件 → 解析 → 切块 → 存 Document + Chunks → embedding → 写 Qdrant
Parse.Cloud.define(
  'knowledgeUpload',
  async (request) => {
    const { url, title } = resolveFile(request.params);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `文件下载失败（HTTP ${res.status}）`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    let text;
    try {
      text = await parseDocument(buffer, request.params.mimeType, title);
    } catch (err) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `文档解析失败：${err.message}`);
    }
    if (!text.trim()) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '文档内容为空，无法入库');
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '切块结果为空');
    }

    const doc = new Parse.Object('Document');
    doc.set('title', title);
    doc.set('sourceType', 'upload');
    doc.set('mimeType', request.params.mimeType || '');
    doc.set('status', 'parsing'); // 向量化完成前不视为可检索
    doc.set('chunkCount', chunks.length);
    doc.set('author', request.user);
    await doc.save(null, { useMasterKey: true });

    const chunkObjects = chunks.map((c, i) => {
      const obj = new Parse.Object('Chunk');
      obj.set('documentId', doc.id);
      obj.set('chunkIndex', i);
      obj.set('content', c.content);
      obj.set('tokenCount', c.tokenCount);
      return obj;
    });

    try {
      await Parse.Object.saveAll(chunkObjects, { useMasterKey: true });

      // 向量化 + 写 Qdrant（payload 带 chunkId/documentId/title，召回后按 chunkId 回 Mongo 取正文）
      const vectors = await embedBatch(chunks.map((c) => c.content));
      await upsertPoints(
        chunkObjects.map((obj, i) => ({
          chunkId: obj.id,
          vector: vectors[i],
          payload: { chunkId: obj.id, documentId: doc.id, chunkIndex: i, title },
        }))
      );
    } catch (err) {
      // 向量链路失败：回滚 Mongo 半成品，整体失败（不留“有原文无向量”的幽灵文档）
      await Parse.Object.destroyAll(chunkObjects, { useMasterKey: true }).catch(() => {});
      await doc.destroy({ useMasterKey: true }).catch(() => {});
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `向量化入库失败：${err.message}`);
    }

    doc.set('status', 'ready');
    await doc.save(null, { useMasterKey: true });

    return { id: doc.id, title, chunkCount: chunks.length };
  },
  { requireUser: true }
);

// 2. 列表（分页，倒序）
Parse.Cloud.define(
  'knowledgeList',
  async (request) => {
    const page = Math.max(parseInt(request.params?.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(request.params?.pageSize, 10) || 10, 1), 100);

    const query = new Parse.Query('Document');
    query.descending('createdAt');
    const total = await query.count({ useMasterKey: true });
    query.skip((page - 1) * pageSize);
    query.limit(pageSize);

    const docs = await query.find({ useMasterKey: true });
    const list = docs.map((d) => ({
      id: d.id,
      title: d.get('title'),
      mimeType: d.get('mimeType'),
      status: d.get('status'),
      chunkCount: d.get('chunkCount') || 0,
      createdAt: d.get('createdAt') ? d.get('createdAt').toISOString() : null,
    }));

    return { list, total, page, pageSize };
  },
  { requireUser: true }
);

// 3. 删除：仅作者本人或管理员
Parse.Cloud.define(
  'knowledgeDelete',
  async (request) => {
    const { id } = request.params || {};
    if (!id) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '缺少文档 ID');

    const doc = await new Parse.Query('Document').get(id, { useMasterKey: true });
    const owner = doc.get('author');
    const isOwner = owner && owner.id === request.user.id;
    const isAdmin = request.user.get('role') === ROLE_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '只能删除自己上传的文档');
    }

    const chunkQuery = new Parse.Query('Chunk');
    chunkQuery.equalTo('documentId', id);
    chunkQuery.limit(1000);
    const chunks = await chunkQuery.find({ useMasterKey: true });
    if (chunks.length) {
      await Parse.Object.destroyAll(chunks, { useMasterKey: true });
    }
    await doc.destroy({ useMasterKey: true });

    // 同步清理 Qdrant 向量（失败仅告警：Mongo 已删，残留向量召回后取不到正文也不影响正确性）
    await deleteByDocument(id).catch((err) => {
      console.error('[knowledge] Qdrant 向量清理失败（文档已删）：', err.message);
    });

    return { ok: true, id };
  },
  { requireUser: true }
);
