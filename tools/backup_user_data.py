"""Create a private, consistent copy of the account/sync DB and live public shares.

Run on the server. The caller supplies a new, non-public destination directory.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile


def readonly(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def verify(folder):
    with closing(readonly(folder / "companion.sqlite3")) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or db.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("SQLite integrity check failed")
        blobs = 0
        for digest, raw in db.execute("SELECT sha256,data FROM conversation_sync_blobs"):
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("Sync blob digest mismatch")
            blobs += 1
        shares = 0
        for (share_id,) in db.execute("SELECT id FROM conversation_shares WHERE revoked=0"):
            if not re.fullmatch(r"[A-Za-z0-9_-]{32}", share_id):
                raise ValueError("Invalid share identity")
            sub = folder / "conversation-shares" / share_id
            manifest = json.loads((sub / "snapshot.json").read_bytes())
            if manifest['id'] != share_id:
                raise ValueError("Share identity mismatch")
            for image in manifest['images']:
                name = image['storage_id']
                if not re.fullmatch(r"[a-f0-9]{32}", name) or (sub / name).stat().st_size != image['size']:
                    raise ValueError("Share image mismatch")
            shares += 1
        return {"sqlite_integrity": "ok", "sync_blobs_verified": blobs, "live_shares_verified": shares}


def backup(source, destination):
    source = source.resolve(strict=True)
    destination = destination.resolve()
    if destination.exists() or source in destination.parents:
        raise ValueError("Choose a new directory outside the service data directory")
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        stage = Path(temporary) / 'snapshot'
        stage.mkdir(mode=0o700)
        database = source / 'companion.sqlite3'
        with closing(sqlite3.connect(database.as_uri() + '?mode=rw', uri=True, timeout=3)) as lock:
            # Serialize with share creation and revocation while capturing DB and external files.
            lock.execute('BEGIN IMMEDIATE')
            with closing(readonly(database)) as reader, closing(sqlite3.connect(stage / database.name)) as writer:
                reader.backup(writer)
            for (share_id,) in lock.execute('SELECT id FROM conversation_shares WHERE revoked=0'):
                if not re.fullmatch(r'[A-Za-z0-9_-]{32}', share_id):
                    raise ValueError('Invalid share identity')
                shutil.copytree(source / 'conversation-shares' / share_id, stage / 'conversation-shares' / share_id)
        result = verify(stage)
        stage.rename(destination)
        return result


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    create = commands.add_parser('backup')
    create.add_argument('source', type=Path)
    create.add_argument('destination', type=Path)
    check = commands.add_parser('verify')
    check.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(backup(args.source, args.destination) if args.action == 'backup' else verify(args.destination)))
