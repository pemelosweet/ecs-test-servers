#!/usr/bin/env bash
# Let's Encrypt 证书自动续期脚本
#
# 行为：
#   1. 调用 certbot renew（仅在证书剩余有效期 < 30 天时真正续期）
#   2. 如果续期成功，通知 form-frontend 容器 reload nginx，让新证书生效
#   3. 失败时输出错误到日志（建议配合告警监控）
#
# 用法（生产 ECS 上加到 crontab，每周一次即可）：
#   0 4 * * 1 /opt/backend/scripts/renew-cert.sh >> /var/log/xmg-cert.log 2>&1
set -euo pipefail

CONTAINER="form-frontend"
DOMAINS=("admin.xmg111.xyz" "xmg111.xyz")

echo "[cert] start at $(date)"

# 1. 尝试续期（certbot 会自己判断哪些证书需要续）
if certbot renew --quiet; then
    echo "[cert] renew check ok"
else
    echo "[cert] renew failed!" >&2
    exit 1
fi

# 2. 验证证书文件实际更新（mtime 在 1 小时内才 reload）
NEED_RELOAD=0
for d in "${DOMAINS[@]}"; do
    cert_file="/etc/letsencrypt/live/${d}/fullchain.pem"
    if [ -f "${cert_file}" ]; then
        if find "${cert_file}" -mmin -60 | grep -q .; then
            echo "[cert] ${d} cert updated"
            NEED_RELOAD=1
        fi
    fi
done

# 3. 有更新就 reload nginx（容器必须运行中）
if [ "${NEED_RELOAD}" -eq 1 ]; then
    if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
        docker exec "${CONTAINER}" nginx -s reload
        echo "[cert] nginx reloaded"
    else
        echo "[cert] ${CONTAINER} not running, skip reload"
    fi
else
    echo "[cert] no cert changed, skip reload"
fi

echo "[cert] done at $(date)"
