"""Send a single ServerChan reminder when DeepSeek has pending feedback."""

import argparse
from contextlib import closing
from http.client import HTTPConnection, HTTPException
import json
import os
from pathlib import Path
import sqlite3
import sys


DB_PATH = Path('/var/lib/deepseek/companion.sqlite3')
RELAY_RESPONSE_LIMIT = 16 * 1024


def count_pending(path):
    uri = path.resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True, timeout=3)) as db:
        return db.execute('SELECT COUNT(*) FROM feedback WHERE status = ?', ('pending',)).fetchone()[0]


def send_reminder(count, token):
    body = json.dumps({
        'title': f'DeepSeek 有 {count} 条待查看反馈',
        'desp': '打开 DeepSeek 记忆聊天 App，在「开发者工具 → 意见审批」查看。',
    }, ensure_ascii=False).encode('utf-8')
    with closing(HTTPConnection('127.0.0.1', 3102, timeout=18)) as relay:
        relay.request('POST', '/send', body, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Relay-Token': token,
        })
        with relay.getresponse() as response:
            if not 200 <= response.status < 300:
                return False
            data = response.read(RELAY_RESPONSE_LIMIT + 1)
    if len(data) > RELAY_RESPONSE_LIMIT:
        return False
    result = json.loads(data)
    return isinstance(result, dict) and type(result.get('code')) is int and result['code'] == 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Check the pending count without contacting the relay.')
    args = parser.parse_args(argv)
    try:
        count = count_pending(DB_PATH)
    except (OSError, sqlite3.Error):
        print('feedback reminder: cannot read pending count', file=sys.stderr)
        return 1
    if args.dry_run or count == 0:
        print(f'feedback reminder: pending={count} action={"dry-run" if args.dry_run else "skipped"}')
        return 0

    token = os.environ.get('SERVERCHAN_RELAY_TOKEN')
    if not token:
        print('feedback reminder: relay credential unavailable', file=sys.stderr)
        return 1
    try:
        accepted = send_reminder(count, token)
    except (OSError, ValueError, HTTPException):
        print('feedback reminder: relay acceptance unconfirmed', file=sys.stderr)
        return 1
    if not accepted:
        print('feedback reminder: relay did not confirm acceptance', file=sys.stderr)
        return 1
    print(f'feedback reminder: pending={count} action=accepted')
    return 0


if __name__ == '__main__':
    sys.exit(main())
