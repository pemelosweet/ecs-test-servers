# 权限管理 + 用户管理（RBAC 简化版）

日期：2026-08-15 ｜ 状态：adopted ｜ 关联：cloud/admin.js、cloud/admin-constants.js、seed.js、ecs-frontend `pages/UserManagementPage`、`pages/PermissionPage`

## 1. 需求

1. **角色**：普通用户、管理员两级。
2. **菜单权限**：按角色控制可访问的菜单；**权限管理、用户管理两个菜单对管理员默认勾选且禁止取消**（锁死）。
3. **用户管理**（仅管理员可见）：
   - 支持按「用户名称 / 类型（角色）/ 状态」搜索；
   - 列表展示：用户名称、角色、状态、注册日期、操作（禁用 / 删除）；
   - **禁用**后该用户禁止登录（并立即吊销其会话）；
   - **删除**后用户被完全移除（连带个人档案与全部会话）。

## 2. 数据模型

| 对象 | 字段 | 说明 |
| --- | --- | --- |
| `_User.role` | String | `admin` \| `user`，注册默认 `user`；seed 创建默认管理员 |
| `_User.status` | String | `active` \| `disabled`，默认 `active` |
| `MenuPermission` | `role` String + `menus` Array | 每角色一行，存可访问菜单 key 列表；客户端不可直读写（CLP 全关），只经 Cloud 函数（master key） |

默认菜单权限（`cloud/admin-constants.js` 的 `DEFAULT_MENUS`，新增菜单需同步前端 `menuConfig.jsx`）：

- admin：`/home /org /profile /images /users /permissions`
- user：`/home /org /profile /images`

管理员专属（锁定）菜单（`LOCKED_MENUS` / `ADMIN_ONLY_MENUS`）：`/permissions`、`/users` ——
对管理员：默认勾选且禁止取消，保存时服务端强制并入；
对普通用户：永不可勾选/不可拥有，读取与保存时服务端一律剔除（前端权限管理页两列均显示锁定，客户端无法绕过）。

## 3. Cloud 函数（cloud/admin.js）

| 函数 | 权限 | 说明 |
| --- | --- | --- |
| `adminUserList` | 管理员 | 分页 + username 模糊（不区分大小写）/ role / status 过滤，返回 `{ list, total, page, pageSize }` |
| `adminSetUserStatus` | 管理员 | `status: active\|disabled`；禁用时删除该用户全部 `_Session` 立即踢下线 |
| `adminDeleteUser` | 管理员 | 删除用户 + 其 `Profile`（author 指针）+ 全部会话，彻底移除 |
| `getMenuPermissions` | 登录用户 | 返回当前用户 `{ role, menus }` |
| `adminGetMenuPermissions` | 管理员 | 返回 `{ user, admin, locked }` 供权限管理页渲染 |
| `adminUpdateMenuPermissions` | 管理员 | 保存权限；锁定菜单强制并入 admin 列表 |

安全约束（`assertAdmin`）：管理函数仅 `role=admin` 会话可调用（master key 例外）；对目标用户禁止操作自身；**管理员账户受保护**，不可被禁用/删除（防止把自己锁死或删光管理员）。

登录拦截（`cloud/main.js` `beforeLogin`）：`status === 'disabled'` 一律拒绝登录，提示「账号已被禁用，请联系管理员」。

## 4. 初始化与存量数据（seed.js，幂等）

1. 无 `role=admin` 用户时创建默认管理员：`ADMIN_INIT_USERNAME`（默认 `xmg001`，已存在同名用户则提升为管理员、保留原密码）/ `ADMIN_INIT_PASSWORD`（新建时默认 `admin123456`，生产务必覆盖）；旧 seed 产物 `admin` 账号会自动降级为普通用户；
2. 存量用户缺 `role/status` 时回填 `user/active`；
3. `MenuPermission` 表为空时写入默认权限。

⚠️ `seed.js` 只允许 require `cloud/admin-constants.js`（纯常量），**禁止** require `cloud/admin.js`：后者含 `Parse.Cloud.define`，若在 Parse 的 cloud 加载器之外先执行一次，模块体被 require 缓存，Cloud 函数将注册不上。

## 5. 前端

- 菜单与路由：`menuConfig.jsx` 新增 `/users`（用户管理）、`/permissions`（权限管理）；`router/index.jsx` 两条路由包 `PermissionGuard`，与侧边菜单过滤双保险；
- 权限工具：`lib/permissions.js`（角色判断、`loadMenuPermissions` 带缓存、登录登出失效）；
- `MainLayout` 按权限过滤侧边菜单，Header 显示角色标签；
- 用户管理页：搜索栏（名称/类型/状态）+ 表格（名称/角色/状态/注册日期/操作）+ 服务端分页；当前账号与管理员账户的操作按钮置灰并提示原因；
- 权限管理页：菜单 × 角色勾选矩阵；管理员列的「权限管理/用户管理」勾选锁定并带「锁定」标记；普通用户列同样禁用并带「仅管理员」标记，两者均不可编辑。

## 6. 已知边界

- 角色目前固定两级，未做自定义角色；`MenuPermission` 按角色存菜单数组，扩展多角色只需新增行。
- 删除用户时联动清理其图床数据：`ImageAsset` 记录与 OSS 对象一并删除（OSS 删除失败仅删记录并记日志，不阻断用户删除）；当前删除范围 = 用户 + Profile + ImageAsset/OSS 对象 + Session。
- 管理员账户不可被禁用/删除是刻意保护；如需多管理员互管，需先引入「至少保留一名启用管理员」约束。
