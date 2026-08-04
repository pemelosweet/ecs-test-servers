# ecs-test-servers

表单后端（FastAPI + SQLite）在 ECS 上的部署编排，配合 [ecs-frontend](https://github.com/pemelosweet/ecs-frontend) 容器承载 `admin.xmg111.xyz`（表单后台）和 `xmg111.xyz`（博客）两个站点。

## 部署结构

```
/opt/backend           ← 本仓库（docker-compose.yml + scripts/）
/var/www/frontend      ← ecs-frontend 仓库（nginx + React 构建产物）
/opt/blog/public       ← ecs-blog 仓库（博客静态文件）
```

## 启动

```bash
cd /opt/backend
docker compose up -d --build
```

## 运维（P0 必做）

### 1. SQLite + 附件每日自动备份

```bash
# 宿主机装 sqlite3（用于热备，不中断服务）
yum install -y sqlite   # CentOS/AlmaLinux
# apt install -y sqlite3  # Debian/Ubuntu

# 给脚本执行权限
chmod +x /opt/backend/scripts/backup-sqlite.sh

# 加入 crontab，每天凌晨 3 点执行
crontab -e
# 添加：
#   0 3 * * * /opt/backend/scripts/backup-sqlite.sh >> /var/log/xmg-backup.log 2>&1
```

备份产物：`/opt/backend/backups/form-YYYYMMDD-HHMMSS.tar.gz`（自动保留 7 天）

### 2. Let's Encrypt 证书自动续期

```bash
# 给脚本执行权限
chmod +x /opt/backend/scripts/renew-cert.sh

# 加入 crontab，每周一凌晨 4 点检查续期
crontab -e
# 添加：
#   0 4 * * 1 /opt/backend/scripts/renew-cert.sh >> /var/log/xmg-cert.log 2>&1
```

脚本会自动判断是否需要续期，并在续期成功后 reload nginx。

## 环境变量

可在 `/opt/backend/.env` 中覆盖默认值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FRONTEND_DIR` | `/var/www/frontend` | 前端仓库路径 |
| `BLOG_DIR` | `/opt/blog/public` | 博客静态文件路径 |
| `BACKEND_PORT` | `8000` | 后端服务端口（内网） |
| `TZ` | `Asia/Shanghai` | 容器时区 |
