// Schema 初始化：启动时幂等创建 Org / Profile 两个 class
const config = require('./config');

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
};

async function initSchema() {
  const Parse = require('parse/node');
  try {
    Parse.initialize(config.APP_ID, null, config.MASTER_KEY);
  } catch {
    // Parse Server 已初始化过 SDK，忽略重复初始化
  }
  Parse.serverURL = config.SERVER_URL;

  for (const [className, fields] of Object.entries(SCHEMAS)) {
    try {
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
        } else {
          schema.addString(name, def.required);
        }
      }
      await schema.save();
      console.log(`Schema "${className}" ready`);
    } catch (err) {
      // class 已存在时忽略
      if (err.message?.includes('already exists')) {
        console.log(`Schema "${className}" already exists`);
      } else {
        console.error(`Schema "${className}" error:`, err.message);
      }
    }
  }
}

module.exports = initSchema;
