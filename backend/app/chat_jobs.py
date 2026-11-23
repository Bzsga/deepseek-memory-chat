"""Short-lived, owner-scoped replay of managed chat SSE after a client disconnect."""

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import anyio


logger = logging.getLogger(__name__)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,100}\Z")
MAX_CHAT_JOB_BODY = 4 * 1024 * 1024
MAX_RESULT_BYTES = 16 * 1024 * 1024
MAX_RETAINED_BYTES = 96 * 1024 * 1024
SSE_BOUNDARY = re.compile(rb"(?:\r\n|\n|\r(?!\n|$))(?:\r\n|\n|\r(?!\n|$))")
REPLAY_CHUNK_BYTES = 64 * 1024
AUTH_INTERVAL = 2
HEARTBEAT_SECONDS = 10
NO_CHAT_PROGRESS_SECONDS = 180
CHAT_PROGRESS_EVENT = re.compile(
    rb"(?:^|[\r\n])event:[ \t]*(?:message_start|content_block_start|content_block_delta|"
    rb"content_block_stop|message_delta)[ \t]*[\r\n]"
)
CHAT_INPUT_LIMIT_CODE = "chat_input_too_long"
CHAT_INPUT_LIMIT_MESSAGE = "本次输入超过当前模型的容量。请缩短消息，或拆分附件后只上传需要的片段。"
_INPUT_LIMIT_PATTERN = re.compile(
    r"^\s*user input too long,\s*([0-9]{1,12})\s+tokens exceeds max\s+([0-9]{1,12})\s+tokens\b", re.I,
)
_MAX_TOKEN_COUNT = 999_999_999_999


def chat_input_limit(error):
    """Classify an explicit rejection, retaining only a pair of validated token counts."""
    fields = error if isinstance(error, dict) else {}
    coded = fields.get("code") in (CHAT_INPUT_LIMIT_CODE, "context_length_exceeded")
    message = fields.get("message", error)
    match = _INPUT_LIMIT_PATTERN.match(message[:512]) if isinstance(message, str) else None
    if coded:
        count, maximum = fields.get("input_tokens"), fields.get("max_input_tokens")
        if type(count) is int and type(maximum) is int and 0 < maximum < count <= _MAX_TOKEN_COUNT:
            return {"input_tokens": count, "max_input_tokens": maximum}
    if match:
        count, maximum = map(int, match.groups())
        if 0 < maximum < count:
            return {"input_tokens": count, "max_input_tokens": maximum}
    return {} if coded else None


class ChatJobError(Exception):
    def __init__(self, status, message, code, *, input_limit=None):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code
        self.input_limit = input_limit


def _interrupted():
    return ChatJobError(502, "后台回复未完整收到，无法恢复本次生成。", "chat_job_interrupted")


def _cancelled():
    return ChatJobError(409, "已停止生成。", "chat_job_cancelled")


def _capacity():
    return ChatJobError(429, "后台聊天任务已满，请稍后再发送。", "chat_job_capacity")


def _error_frame(error):
    payload = {"type": "error", "error": {"type": "api_error", "message": error.message,
               "status": error.status, "code": error.code, **(error.input_limit or {})}}
    return b"event: error\ndata: " + json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n\n"


def _sanitized_input_limit_frame(frame):
    data = b"\n".join(line[5:].lstrip(b" ") for line in frame.splitlines() if line.startswith(b"data:"))
    try:
        payload = json.loads(data)
    except (ValueError, RecursionError):
        payload = data.decode("utf-8", errors="replace")
    error = payload.get("error", payload) if isinstance(payload, dict) else payload
    counts = chat_input_limit(error)
    if counts is None:
        return frame
    return _error_frame(ChatJobError(400, CHAT_INPUT_LIMIT_MESSAGE, CHAT_INPUT_LIMIT_CODE, input_limit=counts))


def _terminal_event(frame):
    if b"message_stop" not in frame and b"error" not in frame:
        return None
    event, data = b"", []
    for line in frame.splitlines():
        if line.startswith(b"event:"):
            event = line[6:].strip()
        elif line.startswith(b"data:"):
            data.append(line[5:].lstrip(b" "))
    if event == b"error":
        return "failed"
    try:
        payload = json.loads(b"\n".join(data))
    except (ValueError, RecursionError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("type") == "message_stop":
        return "completed"
    if payload.get("type") == "error" or isinstance(payload.get("error"), dict):
        return "failed"
    return None


@dataclass
class _LiveJob:
    data: bytearray = field(default_factory=bytearray)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    started: bool = False
    finalizing: bool = False
    terminal_status: str | None = None
    stop_reason: str | None = None
    expires_at: float | None = None
    readers: int = 0

    def publish(self, frame):
        if frame:
            self.data.extend(frame)
        changed, self.changed = self.changed, asyncio.Event()
        changed.set()


class ChatJobs:
    def __init__(self, store, *, ttl_seconds=1800, concurrency=3, max_result_bytes=MAX_RESULT_BYTES,
                 max_retained_bytes=MAX_RETAINED_BYTES, clock=time.time):
        self.store, self.ttl, self.clock = store, ttl_seconds, clock
        self.concurrency = concurrency
        self.max_result_bytes, self.max_retained_bytes = max_result_bytes, max_retained_bytes
        self._jobs = {}
        self._lock = asyncio.Lock()
        self._submitting = 0
        self._cleanup_task = None
        self.ready = False

    def _initialize(self):
        now = self.clock()
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS managed_chat_jobs (
                owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id) ON DELETE CASCADE,
                client_id TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL,
                expires_at REAL NOT NULL, PRIMARY KEY(owner_id, client_id))""")
            db.execute("""UPDATE managed_chat_jobs SET status='interrupted',expires_at=MIN(expires_at,?)
                WHERE status='running'""", (now + self.ttl,))

    async def start(self):
        if not self.ready:
            await asyncio.to_thread(self._initialize)
            self.ready = True
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self):
        self.ready = False
        async with self._lock:
            active = []
            for job in self._jobs.values():
                if job.expires_at is None:
                    self._stop_job(job, "interrupted")
                    active.append(job.task)
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            await asyncio.gather(self._cleanup_task, return_exceptions=True)
            self._cleanup_task = None
        self._jobs.clear()

    @asynccontextmanager
    async def accepting(self):
        if not self.ready:
            raise ChatJobError(503, "后台聊天暂不可用。", "chat_job_unavailable")
        if self._submitting >= self.concurrency:
            raise _capacity()
        self._submitting += 1
        try:
            yield
        finally:
            self._submitting -= 1

    def _key(self, owner_id, client_id):
        if not isinstance(client_id, str) or not REQUEST_ID.fullmatch(client_id):
            raise ChatJobError(400, "后台聊天请求编号无效。", "chat_job_invalid_id")
        return owner_id, client_id

    def _record(self, key):
        with self.store.connection() as db:
            return db.execute("""SELECT request_hash,status,expires_at FROM managed_chat_jobs
                WHERE owner_id=? AND client_id=?""", key).fetchone()

    def _insert(self, key, request_hash):
        with self.store.connection(write=True) as db:
            db.execute("""INSERT INTO managed_chat_jobs(owner_id,client_id,request_hash,status,expires_at)
                VALUES(?,?,?,'running',?)""", (*key, request_hash, self.clock() + self.ttl))

    def _finish(self, key, status, expires_at):
        with self.store.connection(write=True) as db:
            db.execute("""UPDATE managed_chat_jobs SET status=?,expires_at=? WHERE owner_id=? AND client_id=?
                AND status='running'""", (status, expires_at, *key))

    @staticmethod
    def _check_record(row, now):
        if row is None:
            raise ChatJobError(404, "后台聊天任务不存在。", "chat_job_not_found")
        if row["expires_at"] <= now:
            raise ChatJobError(410, "后台聊天结果已超过保留时间。", "chat_job_expired")

    def _prune(self):
        now = self.clock()
        for key, job in list(self._jobs.items()):
            if job.expires_at is not None and job.expires_at <= now:
                self._jobs.pop(key)
                job.data.clear()

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(min(30, self.ttl))
            self._prune()

    async def create(self, owner_id, client_id, request_hash, generate, quota):
        key = self._key(owner_id, client_id)
        async with self._lock:
            if not self.ready:
                raise ChatJobError(503, "后台聊天暂不可用。", "chat_job_unavailable")
            self._prune()
            row = await asyncio.to_thread(self._record, key)
            if row is not None:
                if row["request_hash"] != request_hash:
                    raise ChatJobError(409, "该请求编号已用于另一条消息。", "chat_job_conflict")
                self._check_record(row, self.clock())
                return
            # Recheck atomically at dispatch. The snapshot rejects known ineligible new jobs
            # before allocating a result buffer or a durable idempotency record.
            if not quota["enabled"]:
                raise ChatJobError(503, quota["message"], "chat_job_unavailable")
            if quota["weekly_remaining"] <= 0 or quota["user_weekly_remaining"] <= 0:
                raise ChatJobError(429, quota["message"], "chat_job_quota")
            active = [existing_owner for (existing_owner, _), job in self._jobs.items() if job.expires_at is None]
            retained = sum(len(job.data) for job in self._jobs.values() if job.expires_at is not None)
            if (owner_id in active or len(active) >= self.concurrency or
                    retained + (len(active) + 1) * (self.max_result_bytes + 4096) > self.max_retained_bytes):
                raise _capacity()
            # Once the idempotency marker commits, create the task even if the HTTP acknowledgement was lost.
            insertion = asyncio.create_task(asyncio.to_thread(self._insert, key, request_hash))
            try:
                await asyncio.shield(insertion)
            except asyncio.CancelledError:
                with anyio.CancelScope(shield=True):
                    await insertion
                    self._schedule(key, generate)
                raise
            self._schedule(key, generate)

    def _schedule(self, key, generate):
        job = self._jobs[key] = _LiveJob()
        job.task = asyncio.create_task(self._run(key, job, generate))

    async def _run(self, key, job, generate):
        job.started = True
        status, failure = "interrupted", _interrupted()
        try:
            if job.stop_reason:
                raise asyncio.CancelledError
            status = await generate(lambda frame: self._publish(job, frame))
            failure = None
        except ChatJobError as error:
            failure = error
            status = "interrupted" if error.code == "chat_job_interrupted" else "failed"
        except asyncio.CancelledError:
            if job.stop_reason == "cancelled":
                status, failure = "cancelled", _cancelled()
        except Exception as error:
            # Do not log the exception message, which can contain user text or credentials.
            logger.error("Background chat task failed type=%s", type(error).__name__)
        finally:
            job.finalizing = True
            if job.terminal_status is not None:
                status, failure = job.terminal_status, None
            with anyio.CancelScope(shield=True):
                expires_at = self.clock() + self.ttl
                try:
                    await asyncio.to_thread(self._finish, key, status, expires_at)
                finally:
                    job.expires_at = expires_at
                    job.publish(_error_frame(failure) if failure else b"")

    def _publish(self, job, frame):
        remaining = self.max_result_bytes - len(job.data)
        terminal = _terminal_event(frame) if len(frame) <= remaining else None
        if terminal == "failed":
            frame = _sanitized_input_limit_frame(frame)
        if len(frame) > remaining:
            raise ChatJobError(502, "后台聊天回复超过暂存上限。", "chat_job_result_too_large")
        job.publish(frame)
        if terminal:
            job.finalizing = True
            job.terminal_status = terminal
        return terminal

    async def get_events(self, owner_id, client_id, authorize):
        key = self._key(owner_id, client_id)
        self._prune()
        job = self._jobs.get(key)
        if job is not None:
            if job.readers >= 3:
                raise _capacity()
            return self._events(job, authorize)
        row = await asyncio.to_thread(self._record, key)
        self._check_record(row, self.clock())
        return self._unavailable(row)

    async def _unavailable(self, row):
        yield _error_frame(_cancelled() if row["status"] == "cancelled" else _interrupted())

    async def _events(self, job, authorize):
        if job.readers >= 3:
            yield _error_frame(_capacity())
            return
        loop = asyncio.get_running_loop()
        checked, heartbeat = 0, loop.time() + HEARTBEAT_SECONDS
        job.readers += 1
        try:
            offset = 0
            while True:
                now = loop.time()
                if now >= checked:
                    if not await authorize():
                        yield _error_frame(ChatJobError(401, "登录已过期，请重新登录。", "chat_job_session_expired"))
                        return
                    checked = loop.time() + AUTH_INTERVAL
                if offset < len(job.data):
                    end = min(offset + REPLAY_CHUNK_BYTES, len(job.data))
                    yield bytes(job.data[offset:end])
                    offset = end
                    heartbeat = loop.time() + HEARTBEAT_SECONDS
                elif job.expires_at is not None:
                    return
                elif now >= heartbeat:
                    yield b": keep-alive\n\n"
                    heartbeat = loop.time() + HEARTBEAT_SECONDS
                else:
                    try:
                        await asyncio.wait_for(job.changed.wait(), timeout=max(0, min(checked, heartbeat) - now))
                    except asyncio.TimeoutError:
                        pass
        finally:
            job.readers -= 1

    @staticmethod
    def _stop_job(job, reason):
        if not job.finalizing and job.stop_reason is None:
            job.stop_reason = reason
            if job.started:
                job.task.cancel()

    async def cancel(self, owner_id, client_id):
        key = self._key(owner_id, client_id)
        async with self._lock:
            self._prune()
            job = self._jobs.get(key)
            if job is None:
                self._check_record(await asyncio.to_thread(self._record, key), self.clock())
            elif job.expires_at is None:
                self._stop_job(job, "cancelled")


async def capture_sse(chunks, publish, max_bytes):
    """Publish whole frames so an upstream partial frame cannot swallow a terminal error."""
    pending = bytearray()
    # Provider keep-alives keep the connection open while generation is stalled.
    # Renew this deadline only after a complete model progress event.
    with anyio.move_on_after(NO_CHAT_PROGRESS_SECONDS) as deadline:
        async for chunk in chunks:
            scan_from = max(0, len(pending) - 3)
            pending.extend(chunk)
            consumed = 0
            for boundary in SSE_BOUNDARY.finditer(pending, scan_from):
                end = boundary.end()
                frame = bytes(pending[consumed:end])
                consumed = end
                terminal = publish(frame)
                if terminal:
                    return terminal
                if CHAT_PROGRESS_EVENT.search(frame):
                    deadline.deadline = anyio.current_time() + NO_CHAT_PROGRESS_SECONDS
            if consumed:
                del pending[:consumed]
            if len(pending) > max_bytes:
                raise ChatJobError(502, "后台聊天回复超过暂存上限。", "chat_job_result_too_large")
    if deadline.cancelled_caught:
        raise ChatJobError(504, "模型长时间未返回新内容，已保留收到的回复。", "chat_job_no_progress")
    # At EOF a trailing CR can no longer be the first byte of CRLF.
    if pending.endswith(b"\r") and SSE_BOUNDARY.search(pending + b"\x00"):
        if terminal := publish(bytes(pending)):
            return terminal
    raise _interrupted()
