"""Verify a publicly staged HTTPS APK against the local signed-release receipt."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', required=True, type=Path)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    local = json.loads(args.metadata.read_text(encoding='utf-8'))
    parts = urlsplit(args.url)
    if (local.get('signatureVerified') is not True or parts.scheme != 'https' or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment or any(c.isspace() or c == chr(92) for c in args.url)):
        parser.error('An HTTPS release URL and a verified local APK receipt are required')
    digest = hashlib.sha256()
    with urlopen(args.url, timeout=30) as response:
        if response.status != 200 or urlsplit(response.geturl()).scheme != 'https':
            parser.error('Mirror did not return an HTTPS file')
        size = 0
        while chunk := response.read(1024**2):
            size += len(chunk)
            if size > 64 * 1024**2:
                parser.error('APK is too large')
            digest.update(chunk)
    if digest.hexdigest() != local['apkSha256']:
        parser.error('APK hash mismatch')
    with args.output.open('x', encoding='utf-8') as out:
        json.dump({'versionCode': local['versionCode'], 'sha256': digest.hexdigest(), 'url': args.url}, out)


if __name__ == '__main__':
    main()
