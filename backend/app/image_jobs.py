"""Owner-scoped image jobs with durable identity and temporary private results."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
import uuid

import anyio


MAX_RESULT_BYTES = 32 * 1024 * 1024
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,100}\Z")
ACTIVE = {"queued", "running"}
logger = logging.getLogger(__name__)


class ImageJobError(Exception):
    def __init__(self, status, message, code):
        self.status, self.message, self.code = status, message, code


@dataclass(frozen=True)
class ImageEditSource:
    content: bytes = field(repr=False)
    mime_type: str


def _utc(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ImageJobs:
    def __init__(self, store, result_dir, *, generator=None, ttl_seconds=86400, cleanup_interval=300,
                 concurrency=2, max_pending=32, clock=time.time):
        self.store, self.result_dir = store, Path(result_dir)
        self.generator, self.ttl, self.cleanup_interval = generator, ttl_seconds, cleanup_interval
        self.max_pending, self.clock = max_pending, clock
        self._semaphore = asyncio.Semaphore(concurrency)
        self._submit_lock = asyncio.Lock()
        self._tasks = {}
        self._cancelled = set()
        self._cleanup_task = None
        self._started = False
        self._stopping = False

    async def start(self):
        if self._started:
            return
        await asyncio.to_thread(self._initialize)
        self._stopping = False
        self._started = True
        await self.cleanup()
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    def _initialize(self):
        self.result_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.result_dir.chmod(0o700)
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS image_jobs (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id) ON DELETE CASCADE,
                client_request_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, model TEXT NOT NULL,
                status TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL, expires_at REAL NOT NULL,
                error_code TEXT, error_message TEXT, error_status INTEGER, result_sha256 TEXT,
                UNIQUE(owner_id,client_request_id))""")
            pending = [dict(row) for row in db.execute("SELECT * FROM image_jobs WHERE status IN ('queued','running')")]
        for row in pending:
            path = self._path(row["id"])
            try:
                raw = self._read_file(path)
                result = json.loads(raw)
                if not isinstance(result, dict) or set(result) != {"images", "model"} or not result["images"]:
                    raise ValueError
                self._complete(row["id"], hashlib.sha256(raw).hexdigest(), path.stat().st_mtime)
            except (OSError, ValueError, UnicodeError):
                self._terminal(row["id"], "unknown", "image_job_interrupted",
                    "服务曾中断，无法确认这次生成是否完成。请重新发起新的生成任务。", 409)

    async def stop(self):
        async with self._submit_lock:
            if not self._started:
                return
            self._stopping = True
            self._started = False
            tasks = list(self._tasks.items())
        if self._cleanup_task:
            self._cleanup_task.cancel()
        for job_id, task in tasks:
            if job_id not in self._cancelled and not task.done():
                task.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(*(task for _job_id, task in tasks), return_exceptions=True)
            if self._cleanup_task:
                await asyncio.gather(self._cleanup_task, return_exceptions=True)
            await asyncio.to_thread(self._interrupt_active)
        self._cleanup_task = None

    def _interrupt_active(self):
        with self.store.connection(write=True) as db:
            db.execute("""UPDATE image_jobs SET status='unknown',updated_at=?,error_code='image_job_interrupted',
                error_message=?,error_status=409 WHERE status IN ('queued','running')""",
                (self.clock(), "服务曾中断，无法确认这次生成是否完成。请重新发起新的生成任务。"))

    def _path(self, job_id):
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ValueError("Invalid internal image job ID")
        return self.result_dir / (job_id + ".json")

    def _lookup(self, owner, request_id):
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM image_jobs WHERE owner_id=? AND client_request_id=?", (owner, request_id)).fetchone()
        if row is None:
            raise ImageJobError(404, "未找到这次图片生成任务。", "image_job_not_found")
        return dict(row)

    def _metadata(self, row):
        result = {name: row[name] for name in ("id", "client_request_id", "status", "model")}
        result.update(created_at=_utc(row["created_at"]), updated_at=_utc(row["updated_at"]),
                      expires_at=_utc(row["expires_at"]), has_result=row["status"] == "completed")
        if row["error_code"]:
            result["error"] = {"code": row["error_code"], "message": row["error_message"], "status": row["error_status"]}
        return result

    def _create(self, owner, request_id, prompt_hash, model):
        now = self.clock()
        with self.store.connection(write=True) as db:
            previous = db.execute("SELECT * FROM image_jobs WHERE owner_id=? AND client_request_id=?", (owner, request_id)).fetchone()
            if previous:
                if previous["prompt_hash"] and previous["prompt_hash"] != prompt_hash:
                    raise ImageJobError(409, "此请求编号已用于不同的图片描述或原图，请新建任务。", "image_job_conflict")
                return dict(previous), False
            job_id = uuid.uuid4().hex
            db.execute("""INSERT INTO image_jobs(id,owner_id,client_request_id,prompt_hash,model,status,
                created_at,updated_at,expires_at) VALUES(?,?,?,?,?,'queued',?,?,?)""",
                (job_id, owner, request_id, prompt_hash, model, now, now, now + self.ttl))
            return dict(db.execute("SELECT * FROM image_jobs WHERE id=?", (job_id,)).fetchone()), True

    async def create(self, owner, request_id, prompt, token, provider, *, sources: tuple[ImageEditSource, ...] = ()):
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise ImageJobError(400, "生成请求编号无效，请重新打开输入框。", "image_job_invalid_id")
        prompt_digest = hashlib.sha256(prompt.encode("utf-8"))
        prompt_hash = prompt_digest.hexdigest()
        if len(sources) == 1:
            # Preserve fingerprints for jobs created before multiple images were supported.
            edit_digest = hashlib.sha256(prompt_digest.digest())
            edit_digest.update(sources[0].content)
            prompt_hash = "edit:" + edit_digest.hexdigest()
        elif sources:
            edit_digest = hashlib.sha256(prompt_digest.digest())
            for source in sources:
                # Frame each image so different boundaries cannot share a fingerprint.
                edit_digest.update(len(source.content).to_bytes(8, "big"))
                edit_digest.update(source.content)
            prompt_hash = "edit-multi:" + edit_digest.hexdigest()
        async with self._submit_lock:
            if not self._started or self._stopping or self.generator is None:
                raise ImageJobError(503, "图片生成服务正在启动，请稍后重试。", "image_job_unavailable")
            try:
                previous = await asyncio.to_thread(self._lookup, owner, request_id)
            except ImageJobError as error:
                if error.status != 404:
                    raise
            else:
                if previous["prompt_hash"] and previous["prompt_hash"] != prompt_hash:
                    raise ImageJobError(409, "此请求编号已用于不同的图片描述或原图，请新建任务。", "image_job_conflict")
                return await self.get(owner, request_id), False
            if provider is None:
                raise ImageJobError(503, "生图服务尚未配置，请联系管理员。", "image_provider_disabled")
            if len(self._tasks) >= self.max_pending:
                raise ImageJobError(429, "等待生成的图片较多，请稍后再提交。", "image_job_queue_full")
            creation = asyncio.create_task(asyncio.to_thread(self._create, owner, request_id, prompt_hash, provider.model))
            try:
                row, created = await asyncio.shield(creation)
            except asyncio.CancelledError:
                # Once acceptance is durable, an interrupted HTTP confirmation
                # must still leave exactly one independently running task.
                with anyio.CancelScope(shield=True):
                    row, created = await creation
                    if created:
                        self._schedule(row, token, provider, prompt, sources)
                raise
            if created:
                self._schedule(row, token, provider, prompt, sources)
            return self._metadata(row), created

    def _schedule(self, row, token, provider, prompt, sources):
        job_id = row["id"]
        task = asyncio.create_task(self._run(row, token, provider, prompt, sources))
        self._tasks[job_id] = task

        def finished(done):
            self._tasks.pop(job_id, None)
            self._cancelled.discard(job_id)
            if not done.cancelled() and done.exception():
                logger.error("Image job task failed type=%s", type(done.exception()).__name__)

        task.add_done_callback(finished)

    def _running(self, job_id):
        with self.store.connection(write=True) as db:
            return db.execute("UPDATE image_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'",
                              (self.clock(), job_id)).rowcount == 1

    def _terminal(self, job_id, status, code, message, error_status):
        with self.store.connection(write=True) as db:
            return db.execute("""UPDATE image_jobs SET status=?,updated_at=?,error_code=?,error_message=?,error_status=?
                WHERE id=? AND status IN ('queued','running')""", (status, self.clock(), code, message, error_status, job_id)).rowcount == 1

    def _complete(self, job_id, checksum, completed_at):
        with self.store.connection(write=True) as db:
            return db.execute("""UPDATE image_jobs SET status='completed',updated_at=?,expires_at=?,result_sha256=?,
                error_code=NULL,error_message=NULL,error_status=NULL WHERE id=? AND status IN ('queued','running')""",
                (completed_at, completed_at + self.ttl, checksum, job_id)).rowcount == 1

    def _write_result(self, job_id, result):
        raw = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if not raw or len(raw) > MAX_RESULT_BYTES:
            raise ImageJobError(502, "生成图片超过保存上限，请调整输出尺寸。", "image_too_large")
        destination = self._path(job_id)
        temporary = self.result_dir / (".tmp-" + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return hashlib.sha256(raw).hexdigest()

    async def _run(self, row, token, provider, prompt, sources):
        job_id, written = row["id"], False
        checksum = None
        try:
            async with self._semaphore:
                if not await asyncio.to_thread(self._running, job_id):
                    return
                edit = {"sources": sources} if sources else {}
                result = await self.generator(token, row["owner_id"], provider, prompt, **edit)
                writing = asyncio.create_task(asyncio.to_thread(self._write_result, job_id, result))
                try:
                    checksum = await asyncio.shield(writing)
                    written = True
                except asyncio.CancelledError:
                    with anyio.CancelScope(shield=True):
                        checksum = await writing
                        written = True
                    raise
                completed = await asyncio.to_thread(self._complete, job_id, checksum, self.clock())
                if not completed:
                    self._path(job_id).unlink(missing_ok=True)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                if self._stopping and written:
                    await asyncio.to_thread(self._complete, job_id, checksum, self.clock())
                elif job_id in self._cancelled:
                    await asyncio.to_thread(self._terminal, job_id, "cancelled", "image_job_cancelled", "图片生成已取消。", 499)
                    self._path(job_id).unlink(missing_ok=True)
                else:
                    await asyncio.to_thread(self._terminal, job_id, "unknown", "image_job_interrupted",
                        "服务曾中断，无法确认这次生成是否完成。请重新发起新的生成任务。", 409)
            raise
        except ImageJobError as error:
            status = "unknown" if error.code in {"image_timeout", "image_connection"} else "failed"
            await asyncio.to_thread(self._terminal, job_id, status, error.code, error.message, error.status)
        except Exception:
            logger.error("Image job failed code=image_job_internal")
            await asyncio.to_thread(self._terminal, job_id, "unknown", "image_job_internal",
                "图片生成遇到异常，未收到确定结果。请重新发起新的生成任务。", 500)

    async def get(self, owner, request_id):
        row = await asyncio.to_thread(self._lookup, owner, request_id)
        if row["expires_at"] <= self.clock() and row["status"] != "expired":
            await asyncio.to_thread(self._expire, row["id"])
            row = await asyncio.to_thread(self._lookup, owner, request_id)
        return self._metadata(row)

    def _read_file(self, path):
        if path.is_symlink():
            raise ValueError("Unexpected result symlink")
        with path.open("rb") as stream:
            raw = stream.read(MAX_RESULT_BYTES + 1)
        if not raw or len(raw) > MAX_RESULT_BYTES:
            raise ValueError("Invalid result size")
        return raw

    async def result(self, owner, request_id):
        metadata = await self.get(owner, request_id)
        if metadata["status"] == "expired":
            raise ImageJobError(410, "图片结果已超过 24 小时保留期，请查看已保存到本机的图片。", "image_job_expired")
        if metadata["status"] != "completed":
            raise ImageJobError(409, "图片生成尚未完成，请稍后查看任务状态。", "image_job_not_ready")
        row = await asyncio.to_thread(self._lookup, owner, request_id)
        try:
            raw = await asyncio.to_thread(self._read_file, self._path(row["id"]))
            if hashlib.sha256(raw).hexdigest() != row["result_sha256"]:
                raise ValueError("Result integrity mismatch")
            return json.loads(raw)
        except (OSError, ValueError, UnicodeError):
            await asyncio.to_thread(self._expire, row["id"])
            raise ImageJobError(410, "图片结果已不可用，请查看已保存到本机的图片。", "image_job_expired") from None

    def _cancel_record(self, owner, request_id):
        now = self.clock()
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT * FROM image_jobs WHERE owner_id=? AND client_request_id=?", (owner, request_id)).fetchone()
            transitioned = row is not None and row["status"] in ACTIVE
            if row is None:
                # A cancellation can arrive before a delayed creation request.
                # Its durable identity prevents that request from dispatching.
                db.execute("""INSERT INTO image_jobs(id,owner_id,client_request_id,prompt_hash,model,status,
                    created_at,updated_at,expires_at,error_code,error_message,error_status)
                    VALUES(?,?,?,'','','cancelled',?,?,?,'image_job_cancelled',?,499)""",
                    (uuid.uuid4().hex, owner, request_id, now, now, now + self.ttl, "图片生成已取消。"))
            elif transitioned:
                db.execute("""UPDATE image_jobs SET status='cancelled',updated_at=?,error_code='image_job_cancelled',
                    error_message=?,error_status=499 WHERE id=?""", (now, "图片生成已取消。", row["id"]))
            return dict(db.execute("SELECT * FROM image_jobs WHERE owner_id=? AND client_request_id=?",
                                   (owner, request_id)).fetchone()), transitioned

    def _cancel_task(self, row, transitioned):
        if transitioned:
            self._cancelled.add(row["id"])
            task = self._tasks.get(row["id"])
            if task:
                task.cancel()

    async def cancel(self, owner, request_id):
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            raise ImageJobError(400, "生成请求编号无效。", "image_job_invalid_id")
        cancellation = asyncio.create_task(asyncio.to_thread(self._cancel_record, owner, request_id))
        try:
            row, transitioned = await asyncio.shield(cancellation)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                row, transitioned = await cancellation
                self._cancel_task(row, transitioned)
            raise
        self._cancel_task(row, transitioned)
        return self._metadata(row)

    def _expire(self, job_id):
        with self.store.connection(write=True) as db:
            db.execute("""UPDATE image_jobs SET status='expired',updated_at=?,result_sha256=NULL,
                error_code='image_job_expired',error_message=?,error_status=410 WHERE id=?""",
                (self.clock(), "图片结果已超过保留期，请查看已保存到本机的图片。", job_id))
        self._path(job_id).unlink(missing_ok=True)

    async def cleanup(self):
        await asyncio.to_thread(self._cleanup)

    def _cleanup(self):
        with self.store.connection() as db:
            rows = [dict(row) for row in db.execute(
                "SELECT id FROM image_jobs WHERE expires_at<=? AND status!='expired' LIMIT 100", (self.clock(),))]
        for row in rows:
            self._expire(row["id"])
        # Remove orphaned or expired private files after account deletion or a
        # crash between atomic file publication and its metadata update.
        checked = 0
        for path in self.result_dir.iterdir():
            if checked >= 100:
                break
            checked += 1
            if path.name.startswith(".tmp-"):
                if path.stat().st_mtime <= self.clock() - self.ttl:
                    path.unlink(missing_ok=True)
            elif re.fullmatch(r"[a-f0-9]{32}\.json", path.name):
                with self.store.connection() as db:
                    row = db.execute("SELECT status FROM image_jobs WHERE id=?", (path.stem,)).fetchone()
                if row is None or row["status"] == "expired":
                    path.unlink(missing_ok=True)

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(self.cleanup_interval)
            try:
                await self.cleanup()
            except Exception:
                logger.error("Image result cleanup failed")
