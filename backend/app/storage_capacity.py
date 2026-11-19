"""Admission check for growth, called with the SQLite writer lock held."""
from pathlib import Path
from shutil import disk_usage

from .chat import ChatError


def check_growth(path, amount, used, limit, reserve):
    if amount <= 0:
        return
    if used + amount > limit or disk_usage(Path(path).parent).free < reserve + amount:
        raise ChatError(507, "云端可用空间不足，本机内容已保留。请稍后重试或清理云端资料。", code="cloud_storage_full")


def sync_usage(db):
    return db.execute("""SELECT (SELECT COALESCE(SUM(snapshot_size),0) FROM conversation_sync_sessions) +
        (SELECT COALESCE(SUM(size),0) FROM conversation_sync_blobs)""").fetchone()[0]


def share_usage(db):
    return db.execute("SELECT COALESCE(SUM(stored_bytes),0) FROM conversation_shares WHERE revoked=0").fetchone()[0]


def capacity_report(store):
    settings = store.settings
    with store.connection() as db:
        sync, shares = sync_usage(db), share_usage(db)
    free = disk_usage(Path(settings.db_path).parent).free
    return {"sync": sync, "sync_limit": settings.sync_pool_bytes, "shares": shares,
            "shares_limit": settings.share_pool_bytes, "disk_free": free,
            "disk_reserve": settings.disk_reserve_bytes,
            "warning": free <= settings.disk_reserve_bytes + 1024**3 or
                       sync >= settings.sync_pool_bytes * 0.8 or shares >= settings.share_pool_bytes * 0.8}
