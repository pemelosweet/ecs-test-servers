#!/usr/bin/env bash
# SQLite + 附件备份脚本（建议用 cron 每日凌晨跑一次）
#
# 行为：
#   1. 用 sqlite3 .backup 热备（不中断服务，避免直接 copy 正在写入的 .db）
#   2. 连同 uploads/ 目录一起打包成 .tar.gz
#   3. 保留最近 KEEP_DAYS 天的备份，自动清理旧的
#
# 用法（生产 ECS 上加到 crontab，每天凌晨 3 点执行）：
#   0 3 * * * /opt/backend/scripts/backup-sqlite.sh >> /var/log/xmg-backup.log 2>&1
set -euo pipefail

BACKEND_DIR="/opt/backend"
DATA_DIR="${BACKEND_DIR}/data"
BACKUP_DIR="${BACKEND_DIR}/backups"
KEEP_DAYS=7
DB_FILE="${DATA_DIR}/app.db"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_NAME="form-${TIMESTAMP}"
TEMP_DIR="${BACKUP_DIR}/${BACKUP_NAME}"

mkdir -p "${BACKUP_DIR}" "${TEMP_DIR}"

# 1. SQLite 热备（需要宿主机安装 sqlite3，CentOS/AlmaLinux: yum install sqlite -y）
if command -v sqlite3 >/dev/null 2>&1 && [ -f "${DB_FILE}" ]; then
    sqlite3 "${DB_FILE}" ".backup '${TEMP_DIR}/app.db'"
    echo "[backup] SQLite dump ok: ${TEMP_DIR}/app.db"
else
    # 回退：直接 cp（仅在确认写入少时可用）
    cp "${DB_FILE}" "${TEMP_DIR}/app.db" 2>/dev/null || true
    echo "[backup] sqlite3 not found, fallback cp"
fi

# 2. 拷贝 uploads 目录（如存在）
if [ -d "${DATA_DIR}/uploads" ] && [ "$(ls -A "${DATA_DIR}/uploads" 2>/dev/null)" ]; then
    cp -r "${DATA_DIR}/uploads" "${TEMP_DIR}/uploads"
    echo "[backup] uploads copied"
fi

# 3. 打包并删除临时目录
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" -C "${BACKUP_DIR}" "${BACKUP_NAME}"
rm -rf "${TEMP_DIR}"
echo "[backup] archive: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz ($(du -h "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" | cut -f1))"

# 4. 清理旧备份
find "${BACKUP_DIR}" -name "form-*.tar.gz" -type f -mtime "+${KEEP_DAYS}" -delete
echo "[backup] cleaned archives older than ${KEEP_DAYS} days"

echo "[backup] done at $(date)"
