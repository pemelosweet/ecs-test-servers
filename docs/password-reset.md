# 忘记密码（短信验证码重置密码）方案选型

日期：2026-08-15 ｜ 状态：adopted ｜ 关联：cloud/password-reset.js、cloud/aliyun-sms.js、ecs-frontend LoginPage

## 1. 需求与威胁模型

**需求**：用户在登录页忘记密码时，通过注册时绑定的手机号接收验证码，验证通过后设置新密码。以弹窗单屏表单呈现（账号+验证码+新密码一次填完），不新增路由。

**威胁模型**：

| 威胁 | 说明 | 应对 |
| --- | --- | --- |
| 短信轰炸 | 攻击者对任意号码高频触发验证码 | 天级限流（10 条/号）+ 阿里云 60s 间隔流控 |
| 账号枚举 | 用「用户名是否存在」探测有效账号 | 发码前先做 username+phone 双条件匹配，不匹配统一报「不匹配」，不单独区分哪个字段错 |
| 验证码爆破 | 猜 6 位验证码 | 阿里云托管校验，5 分钟有效、校验通过即失效；无本地码可枚举 |
| 旧会话残留 | 改密后被盗会话仍有效 | 改密成功后删除该账号全部 Session |
| 绕过注册限流 | smsSend 与重置发码各自计数，交替调用翻倍额度 | 两个入口共享同一内存限流 Map |

## 2. 候选方案对比

| 方案 | 原理 | 强度 | 成本 | 适用 |
| --- | --- | --- | --- | --- |
| A. 专用重置 Cloud 函数 | 新增 resetPasswordSmsSend（双条件查人再发码）+ resetPassword（核验改密），不动注册链路 | 高：身份双因子 + 共享限流 + 会话吊销 | 两个函数 ~70 行 | 有手机号绑定、需自助重置 |
| B. Parse 内置邮件重置 | passwordResetRequest + SMTP 发邮件 | 中：依赖邮箱可达性 | 需接邮件服务 | 用户普遍绑定邮箱 |
| C. 复用 smsSend + 按手机号重置 | 发码不校验身份，重置时只按 phone 查人 | 低：手机号单因子；知道手机号即可发码重置 | 最低 | 内网/低风险场景 |
| D. 管理员后台人工重置 | Dashboard 手改 | 高（人工核验） | 运营成本高、不可自助 | 兜底渠道 |

**行内最优结论**：有手机号体系时选 A——身份核验前置（先查人再发码）、与注册流控共享、改密即踢旧会话，均为安全基线；B 需额外邮件基建，C 单因子强度不足。

## 3. 本项目 adopted：方案 A

理由：

1. 注册已强制绑定手机号且短信通道现成（阿里云 dypnsapi 生码 + 托管校验，本端不存码）；
2. `username + phone` 双条件比单手机号多一层身份因子，且错误信息统一不泄露字段级差异；
3. 天级限流下沉到 aliyun-sms.js 后与 smsSend 共用同一 Map，交替调用无法绕过；
4. 不动 register/smsSend 现有逻辑，回归面最小。

**流程**：

```
弹窗单屏：用户名 + 手机号 + [获取验证码] + 验证码 + 新密码/确认
  获取验证码 → resetPasswordSmsSend：格式校验 → 双条件查人（master key）→ 天级限流 → 阿里云发码
  重置密码   → resetPassword：双条件查人 → 阿里云托管核码 → 密码 ≥8 位 → master key 改密 → 删除该账号全部 _Session
```

## 4. 已知边界与升级路径

- **限流为内存 Map**：进程重启清零、多实例不共享。当前单实例 pm2 可接受；多实例时迁移 Redis 计数。
- **双条件匹配会轻微泄露「账号+手机号」组合存在性**：攻击者需同时猜中两者，成本已足够高；如后续需更强保护，可在发码前加图形认证（复用 aliyun-captcha.js）。
- **手机号不可自助换绑**：换号用户需管理员重置（方案 D 兜底）。
- **升级路径**：① 接邮件通道后可叠加方案 B 双通道；② 重置入口加图形认证；③ 限流迁 Redis 支撑多实例。

## 5. 关键代码位置

| 位置 | 职责 |
| --- | --- |
| `ecs-test-servers/cloud/password-reset.js` | 两个 Cloud 函数（发码/重置）与会话吊销 |
| `ecs-test-servers/cloud/aliyun-sms.js` | PHONE_RE、assertSmsDailyLimit / bumpSmsDailyCount（共享天级限流）、收发码封装 |
| `ecs-test-servers/cloud/main.js` | smsSend（注册）改用共享限流 |
| `ecs-frontend/src/pages/LoginPage/ForgotPasswordModal.jsx` | 单屏表单弹窗（倒计时、全量校验后一次提交） |
| `ecs-frontend/src/pages/LoginPage/index.jsx` | 「忘记密码？」入口 |
