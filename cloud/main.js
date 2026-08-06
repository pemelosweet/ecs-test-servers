// Parse Server Cloud Code — 业务逻辑

// ==================== Org（组织信息） ====================

/**
 * 保存组织信息（需要登录）
 */
Parse.Cloud.define('saveOrg', async (request) => {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '请先登录');
  }

  const {
    orgName, orgCode, orgType, legalPerson,
    phone, email, address, establishDate,
    status, description,
  } = request.params;

  if (!orgName) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '组织名称不能为空');
  }

  const Org = Parse.Object.extend('Org');
  const org = new Org();
  org.set('orgName', orgName);
  org.set('orgCode', orgCode || null);
  org.set('orgType', orgType || null);
  org.set('legalPerson', legalPerson || null);
  org.set('phone', phone || null);
  org.set('email', email || null);
  org.set('address', address || null);
  org.set('establishDate', establishDate || null);
  org.set('status', status ?? true);
  org.set('description', description || null);
  org.set('author', request.user);

  await org.save(null, { useMasterKey: true });
  return { id: org.id, ...org.toJSON() };
});

/**
 * 获取最新组织记录（公开）
 */
Parse.Cloud.define('getLatestOrg', async () => {
  const query = new Parse.Query('Org');
  query.descending('createdAt');
  query.limit(1);
  const org = await query.first({ useMasterKey: true });
  if (!org) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, '暂无组织信息');
  }
  return { id: org.id, ...org.toJSON() };
});

// ==================== Profile（个人档案） ====================

/**
 * 保存个人档案（需要登录）
 * 头像由前端先上传为 Parse.File，再把 file 对象传过来
 */
Parse.Cloud.define('saveProfile', async (request) => {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, '请先登录');
  }

  const {
    name, gender, birthday, avatar,
    phone, email, address, website, bio,
    education, work, skills, projects,
    socialLinks, interests,
  } = request.params;

  if (!name) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, '姓名不能为空');
  }

  // 校验 JSON 字段
  const jsonFields = { education, work, skills, projects, interests };
  for (const [key, val] of Object.entries(jsonFields)) {
    if (val != null && !Array.isArray(val)) {
      throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `${key} 必须是数组`);
    }
  }
  if (socialLinks != null && typeof socialLinks !== 'object') {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'socialLinks 必须是对象');
  }

  const Profile = Parse.Object.extend('Profile');
  const profile = new Profile();
  profile.set('name', name);
  profile.set('gender', gender || null);
  profile.set('birthday', birthday || null);
  profile.set('phone', phone || null);
  profile.set('email', email || null);
  profile.set('address', address || null);
  profile.set('website', website || null);
  profile.set('bio', bio || null);
  profile.set('education', education || []);
  profile.set('work', work || []);
  profile.set('skills', skills || []);
  profile.set('projects', projects || []);
  profile.set('socialLinks', socialLinks || null);
  profile.set('interests', interests || []);
  profile.set('author', request.user);

  // 头像：前端已通过 Parse.File 直传 OSS，这里只接收文件引用
  if (avatar instanceof Parse.File) {
    profile.set('avatar', avatar);
  }

  await profile.save(null, { useMasterKey: true });
  return { id: profile.id, ...profile.toJSON() };
});

/**
 * 获取最新个人档案（公开，供 blog 使用）
 */
Parse.Cloud.define('getLatestProfile', async () => {
  const query = new Parse.Query('Profile');
  query.descending('createdAt');
  query.limit(1);
  query.include('avatar');
  const profile = await query.first({ useMasterKey: true });
  if (!profile) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, '暂无个人档案');
  }
  const json = profile.toJSON();
  // 把 avatar File 对象转为 URL
  if (json.avatar) {
    json.avatarUrl = json.avatar.url;
  }
  return { id: profile.id, ...json };
});
