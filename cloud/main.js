// Cloud Code：beforeSave 触发器（数据校验 + 自动补字段）
// 业务读写走 /classes REST 直连，不再声明 Cloud 函数

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
