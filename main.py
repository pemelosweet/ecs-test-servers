# 表单数据存储/回填服务（FastAPI + SQLite）
# 启动：uvicorn main:app --reload --port 8000
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "app.db"

# 与前端保持一致的附件限制
MAX_FILE_SIZE_MB = 10
MAX_FILE_COUNT = 5

app = FastAPI(title="Form Data Service")

# 允许 vite 开发服务器跨域直连（走 vite 代理时不依赖此配置）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@app.on_event("startup")
def init_db():
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS forms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                type TEXT,
                category TEXT,
                level INTEGER,
                date TEXT,
                status INTEGER,
                desc TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                size INTEGER,
                content_type TEXT
            );
            """
        )


def serialize_form(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    files = db.execute(
        "SELECT id, filename, size, content_type FROM files WHERE form_id = ?",
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "type": row["type"],
        "category": row["category"],
        "level": row["level"],
        "date": row["date"],
        "status": bool(row["status"]),
        "desc": row["desc"],
        "createdAt": row["created_at"],
        "attachments": [
            {
                "id": f["id"],
                "name": f["filename"],
                "size": f["size"],
                "contentType": f["content_type"],
                "url": f"/api/files/{f['id']}",
            }
            for f in files
        ],
    }


@app.post("/api/forms")
async def create_form(
    title: str = Form(...),
    type: Optional[str] = Form(None),
    category: Optional[str] = Form(None),
    level: Optional[int] = Form(None),
    date: Optional[str] = Form(None),
    status: bool = Form(False),
    desc: Optional[str] = Form(None),
    files: List[UploadFile] = File(default=[]),
    keep_file_ids: List[int] = Form(default=[]),
):
    if len(files) + len(keep_file_ids) > MAX_FILE_COUNT:
        raise HTTPException(400, f"附件最多 {MAX_FILE_COUNT} 个")

    with get_db() as db:
        cur = db.execute(
            "INSERT INTO forms (title, type, category, level, date, status, desc, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                title,
                type,
                category,
                level,
                date,
                int(status),
                desc,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        form_id = cur.lastrowid

        # 回填后再次提交时，复用之前已上传的文件（keep_file_ids）
        for fid in keep_file_ids:
            old = db.execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
            if old is None:
                raise HTTPException(400, f"文件 {fid} 不存在")
            db.execute(
                "INSERT INTO files (form_id, filename, stored_name, size, content_type) "
                "VALUES (?, ?, ?, ?, ?)",
                (form_id, old["filename"], old["stored_name"], old["size"], old["content_type"]),
            )

        # 保存新上传的文件
        for up in files:
            content = await up.read()
            if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
                raise HTTPException(400, f"{up.filename} 超过 {MAX_FILE_SIZE_MB}MB")
            stored_name = f"{uuid.uuid4().hex}_{up.filename}"
            (UPLOAD_DIR / stored_name).write_bytes(content)
            db.execute(
                "INSERT INTO files (form_id, filename, stored_name, size, content_type) "
                "VALUES (?, ?, ?, ?, ?)",
                (form_id, up.filename, stored_name, len(content), up.content_type),
            )

        row = db.execute("SELECT * FROM forms WHERE id = ?", (form_id,)).fetchone()
        return serialize_form(db, row)


@app.get("/api/forms")
def list_forms():
    with get_db() as db:
        rows = db.execute("SELECT * FROM forms ORDER BY id DESC").fetchall()
        return [serialize_form(db, r) for r in rows]


@app.get("/api/forms/latest")
def get_latest_form():
    with get_db() as db:
        row = db.execute("SELECT * FROM forms ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            raise HTTPException(404, "暂无提交记录")
        return serialize_form(db, row)


@app.get("/api/forms/{form_id}")
def get_form(form_id: int):
    with get_db() as db:
        row = db.execute("SELECT * FROM forms WHERE id = ?", (form_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "记录不存在")
        return serialize_form(db, row)


@app.delete("/api/forms/{form_id}")
def delete_form(form_id: int):
    with get_db() as db:
        cur = db.execute("DELETE FROM forms WHERE id = ?", (form_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "记录不存在")
        return {"ok": True}


@app.get("/api/files/{file_id}")
def download_file(file_id: int):
    with get_db() as db:
        row = db.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "文件不存在")
    path = UPLOAD_DIR / row["stored_name"]
    if not path.exists():
        raise HTTPException(404, "文件已丢失")
    return FileResponse(path, filename=row["filename"], media_type=row["content_type"])
