"""Check the public manifest and streamed APK against verified local metadata."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(args.metadata.read_text(encoding='utf-8'))
    require(expected.get('signatureVerified') is True, 'Verified local APK required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = 'https://digimonlegend.com/continuation-updates/latest.json'
    with opener.open(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=30) as response:
        require(response.status == 200 and response.geturl() == url, 'Invalid manifest response')
        require(response.headers.get('Cache-Control') == 'no-store', 'Invalid manifest caching')
        raw = response.read(32769)
        require(len(raw) <= 32768, 'Oversized manifest')
        manifest = json.loads(raw)
    for field in ('packageName', 'versionCode', 'versionName', 'minSdk'):
        require(manifest[field] == expected[field], 'Manifest identity mismatch: ' + field)
    require(manifest['sha256'] == expected['apkSha256'], 'Manifest hash mismatch')
    version = expected['versionCode']
    require(manifest['apkUrl'] == f'https://digimonlegend.com/continuation-updates/apks/{version}/deepseek-continuation-{version}.apk', 'Unexpected APK URL')
    digest, size = hashlib.sha256(), 0
    with opener.open(manifest['apkUrl'], timeout=30) as response:
        require(response.status == 200 and response.geturl() == manifest['apkUrl'], 'Invalid APK response')
        require(response.headers.get_content_type() == 'application/vnd.android.package-archive', 'Invalid APK content type')
        require('immutable' in response.headers.get('Cache-Control', ''), 'Invalid APK caching')
        require(int(response.headers['Content-Length']) == manifest['apkSize'], 'Declared APK size mismatch')
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            require(size <= manifest['apkSize'], 'APK exceeds expected size')
            digest.update(chunk)
    require(size == manifest['apkSize'] and digest.hexdigest() == expected['apkSha256'], 'Downloaded APK mismatch')
    receipt = dict(verified=True, versionCode=version, versionName=manifest['versionName'],
                   apkSize=size, sha256=digest.hexdigest(), manifest_no_store=True,
                   apk_immutable=True, public_apk_full_download_verified=True)
    args.output.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
