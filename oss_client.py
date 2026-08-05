"""阿里云 OSS 客户端封装

环境变量（.env 或系统环境变量）：
  OSS_ACCESS_KEY_ID      阿里云 AccessKey ID
  OSS_ACCESS_KEY_SECRET  阿里云 AccessKey Secret
  OSS_ENDPOINT           如 oss-cn-hangzhou.aliyuncs.com
  OSS_BUCKET_NAME        Bucket 名称，如 xiaomge-1
  OSS_BASE_URL           可选，自定义域名或 CDN 地址；未设置则用默认外网地址

用法：
  from oss_client import upload_file, get_file_url
  url = upload_file(file_bytes, "avatars/xxx.jpg", "image/jpeg")
"""
import os
import uuid
from pathlib import Path

import oss2
from dotenv import load_dotenv

# 加载项目根目录的 .env（兼容本地开发）
load_dotenv(Path(__file__).resolve().parent / ".env")

# ── 配置 ──────────────────────────────────────────────
ACCESS_KEY_ID = os.getenv("OSS_ACCESS_KEY_ID", "")
ACCESS_KEY_SECRET = os.getenv("OSS_ACCESS_KEY_SECRET", "")
ENDPOINT = os.getenv("OSS_ENDPOINT", "")
BUCKET_NAME = os.getenv("OSS_BUCKET_NAME", "")
BASE_URL = os.getenv("OSS_BASE_URL", "").rstrip("/")

# ── 懒加载客户端 ──────────────────────────────────────
_auth = None
_bucket = None


def _get_bucket() -> oss2.Bucket:
    global _auth, _bucket
    if _bucket is None:
        if not (ACCESS_KEY_ID and ACCESS_KEY_SECRET and ENDPOINT and BUCKET_NAME):
            raise RuntimeError(
                "OSS 未配置，请设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / "
                "OSS_ENDPOINT / OSS_BUCKET_NAME 环境变量"
            )
        _auth = oss2.Auth(ACCESS_KEY_ID, ACCESS_KEY_SECRET)
        _bucket = oss2.Bucket(_auth, ENDPOINT, BUCKET_NAME)
    return _bucket


# ── 公开接口 ──────────────────────────────────────────

def upload_file(data: bytes, object_key: str, content_type: str) -> str:
    """上传文件到 OSS，返回可访问的 URL。

    Args:
        data: 文件二进制内容
        object_key: OSS 中的对象路径（如 avatars/abc.jpg）
        content_type: MIME 类型

    Returns:
        文件的完整访问 URL
    """
    bucket = _get_bucket()
    headers = {"Content-Type": content_type}
    bucket.put_object(object_key, data, headers=headers)
    return get_file_url(object_key)


def get_file_url(object_key: str) -> str:
    """根据对象路径生成访问 URL。

    如果配置了 OSS_BASE_URL（自定义域名/CDN），则拼接该域名；
    否则使用 OSS 默认的外网访问地址。
    """
    if BASE_URL:
        return f"{BASE_URL}/{object_key}"
    bucket = _get_bucket()
    return f"https://{BUCKET_NAME}.{ENDPOINT}/{object_key}"


def generate_object_key(prefix: str, original_filename: str) -> str:
    """生成唯一的对象路径：{prefix}/{uuid}_{filename}"""
    safe_name = original_filename.replace(" ", "_")
    return f"{prefix}/{uuid.uuid4().hex}_{safe_name}"
