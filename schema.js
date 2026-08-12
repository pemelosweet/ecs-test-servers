// Schema 初始化：声明 Org / Profile 的表结构与访问权限（幂等）
const config = require('./config');

// 类级权限（CLP）：声明式替代业务代码里的鉴权逻辑
// 读公开（博客匿名访问），写需要登录
const CLPS = {
  find: { '*': true },
  get: { '*': true },
  create: { requiresAuthentication: true },
  update: { requiresAuthentication: true },
  delete: { requiresAuthentication: true },
};

// ImageAsset 只允许服务端登记（Cloud 函数带 master key），客户端不可直接写
const IMAGE_ASSET_CLPS = {
  find: { '*': true },
  get: { '*': true },
  create: {},
  update: {},
  delete: {},
};

// 表结构定义：字段名 → 类型（required 表示必填）
const SCHEMAS = {
  Org: {
    orgName: { type: 'String', required: true },
    orgCode: { type: 'String' },
    orgType: { type: 'String' },
    legalPerson: { type: 'String' },
    phone: { type: 'String' },
    email: { type: 'String' },
    address: { type: 'String' },
    establishDate: { type: 'String' },
    status: { type: 'Boolean', defaultValue: true },
    description: { type: 'String' },
  },
  Profile: {
    name: { type: 'String', required: true },
    gender: { type: 'String' },
    birthday: { type: 'String' },
    avatar: { type: 'File' },
    phone: { type: 'String' },
    email: { type: 'String' },
    address: { type: 'String' },
    website: { type: 'String' },
    bio: { type: 'String' },
    education: { type: 'Array' },
    work: { type: 'Array' },
    skills: { type: 'Array' },
    projects: { type: 'Array' },
    socialLinks: { type: 'Object' },
    interests: { type: 'Array' },
  },
  ImageAsset: {
    key: { type: 'String', required: true },
    url: { type: 'String', required: true },
    mime: { type: 'String' },
    size: { type: 'Number' },
    name: { type: 'String' },
    width: { type: 'Number' },
    height: { type: 'Number' },
  },
};

const SCHEMA_CLPS = {
  ImageAsset: IMAGE_ASSET_CLPS,
};

// 按定义构建 Parse.Schema（含 author 指针字段和 CLP）
function buildSchema(className, fields) {
  const Parse = require('parse/node');
  const schema = new Parse.Schema(className);

  for (const [name, def] of Object.entries(fields)) {
    if (def.type === 'File') {
      schema.addFile(name);
    } else if (def.type === 'Array') {
      schema.addArray(name);
    } else if (def.type === 'Object') {
      schema.addObject(name);
    } else if (def.type === 'Boolean') {
      schema.addBoolean(name, def.defaultValue);
    } else if (def.type === 'Pointer') {
      schema.addPointer(name, def.targetClass);
    } else {
      schema.addString(name, def.required);
    }
  }

  // 提交人：指向 _User，由 beforeSave 自动填充
  schema.addPointer('author', '_User');
  schema.setCLP(SCHEMA_CLPS[className] || CLPS);
  return schema;
}

async function initSchema() {
  const Parse = require('parse/node');
  try {
    Parse.initialize(config.APP_ID, null, config.MASTER_KEY);
  } catch {
    // Parse Server 已初始化过 SDK，忽略重复初始化
  }
  Parse.serverURL = config.SERVER_URL;

  for (const [className, fields] of Object.entries(SCHEMAS)) {
    const schema = buildSchema(className, fields);

    // 先查表是否已存在，避免 Parse Server 内部打印 "already exists" 噪音日志
    try {
      await new Parse.Schema(className).get();
      // 表已存在：用 update 同步新增字段和 CLP（已有字段不受影响）
      await schema.update();
      console.log(`Schema "${className}" updated`);
    } catch {
      // 表不存在：创建
      try {
        await schema.save();
        console.log(`Schema "${className}" ready`);
      } catch (err) {
        console.error(`Schema "${className}" error:`, err.message);
      }
    }
  }
}

module.exports = initSchema;
