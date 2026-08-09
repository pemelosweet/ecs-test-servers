# CI/CD 方案学习：GitHub Actions 自托管 Runner 自动部署

> 本文记录项目持续集成方案的选型思考与落地细节，供学习回顾。
链接远程 ssh root@8.210.108.71
## 1. 需求

push 代码到 GitHub 后，ECS 生产环境自动完成：拉代码 → 构建前端 → 同步产物 → 重启后端（即 `deploy/update.sh` 的全流程）。

## 2. 三种候选方案对比

### 方案 A：Actions + 自托管 runner（本项目采用）

```
push → GitHub 触发 workflow → ECS 上的 runner 服务（outbound 长连接接任务）→ 本地执行 update.sh
```

- 真 CI：GitHub 仓库 Actions 页可看每次构建的实时日志、状态、耗时
- 安全：runner 主动向 GitHub 建立连接，**服务器无需开放任何入站端口**（22 端口可继续限制为本机 IP）
- 代价：ECS 多一个常驻 runner 服务；runner 进程由 systemd 托管保活

### 方案 B：Actions + SSH 部署（行内最常见）

```
push → GitHub 云端 runner → SSH 连 ECS 执行 update.sh
```

- 教程最多、配置直观；服务器无常驻 agent
- 代价：22 端口必须对公网开放（GitHub runner 出口 IP 动态变化，无法白名单）；SSH 私钥需存入 GitHub Secrets，多一个机密暴露面
- 适用：不介意 22 开公网 + 密钥认证 + fail2ban 的场景

### 方案 C：服务器 cron 轮询（个人 hack，非行内 CI）

```
ECS 每分钟 git ls-remote 对比 → 有新提交就跑 update.sh
```

- 零平台依赖、零暴露、10 行脚本
- 代价：GitHub 上无日志无状态、失败无通知、≤1 分钟延迟
- 行内不视其为 CI，仅作应急/玩具方案

## 3. 行内最优是什么

| 层 | 标准答案 |
|---|---|
| CI 平台 | GitHub Actions（事实标准） |
| 部署通道 | 托管平台 = 平台自动拉；自有服务器 = SSH 部署最常见；**不开端口/内网 = 自托管 runner**；大厂 = K8s + OIDC |

本项目因安全策略（22 端口收紧）选择自托管 runner。

## 4. 本项目落地架构

只在 **ecs-frontend** 仓库注册一个 runner；三个仓库的 push 都汇聚到它的 workflow：

```
push ecs-frontend ───────────────┐
push ecs-test-servers ──dispatch─┼─→ ecs-frontend/.github/workflows/deploy.yml
push ecs-blog ──────────dispatch─┘        │ runs-on: self-hosted
                                          └─→ bash /opt/xmg/ecs-frontend/deploy/update.sh
```

- `ecs-frontend/.github/workflows/deploy.yml`：监听 push + `repository_dispatch`，在自托管 runner 上跑 update.sh；`concurrency` 保证同一时间只有一个部署任务
- `ecs-test-servers` / `ecs-blog` 的 `.github/workflows/notify-deploy.yml`：push 后用 `DEPLOY_PAT`（GitHub Secrets 中的 Personal Access Token）调 `repository_dispatch` 通知 ecs-frontend

## 5. 关键概念

- **self-hosted runner**：跑在自己机器上的 GitHub Actions 执行器，与云端 runner 行为一致，只是算力自备
- **repository_dispatch**：GitHub 提供的跨仓库 webhook 式触发 API，需带 repo 权限的 token
- **concurrency group**：同组任务排队/互斥，避免两次部署并发踩 /var/www
- **PAT（Personal Access Token）**：此处仅作跨仓库 dispatch 凭证，权限只需 `repo`，建议设过期时间

## 6. 运维速查

```bash
# ECS 上 runner 服务管理（安装目录下）
./svc.sh status / start / stop / restart

# 查看部署日志
# GitHub 仓库 → Actions → Deploy → 点运行记录

# 手动触发一次部署（不 push 代码）
curl -X POST -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/pemelosweet/ecs-frontend/dispatches \
  -d '{"event_type":"deploy"}'
```

## 7. 已知边界

- 一次 push 多个仓库时会产生多次部署任务（push 触发 + dispatch 触发），runner 单任务串行执行，update.sh 幂等，重复执行无副作用，只是多花 1-2 分钟
- runner 以安装用户（root）身份执行脚本，update.sh 内所有命令都具备 root 权限，脚本内容需保持可信（仅维护者能 push main）
