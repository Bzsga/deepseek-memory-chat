"""Check the public manifest and streamed APK against verified local metadata."""
import argparse
import hashlib
import http.client
import io
import json
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


PUBLIC_ORIGIN = 'https://digimonlegend.com'
MIRROR_ORIGIN = 'https://download.digimonlegend.com'
CHANNEL = '/continuation-updates'
MAX_APK_BYTES = 64 * 1024 * 1024


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def public_response(opener, url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
    try:
        return opener.open(request, timeout=30)
    except urllib.error.HTTPError as response:
        return response


def verify_download(stream, headers, expected_size, expected_hash):
    require(headers.get_content_type() == 'application/vnd.android.package-archive', 'Invalid APK content type')
    cache_options = {option.strip().lower() for option in headers.get('Cache-Control', '').split(',')}
    require('immutable' in cache_options, 'Invalid APK caching')
    require(headers.get_all('Content-Length') == [str(expected_size)], 'Declared APK size mismatch')
    digest, size = hashlib.sha256(), 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        require(size <= expected_size, 'APK exceeds expected size')
        digest.update(chunk)
    require(size == expected_size and digest.hexdigest() == expected_hash, 'Downloaded APK mismatch')
    return size, digest.hexdigest()


def verify_mirror(opener, url, size, digest):
    curl = shutil.which('curl')
    if curl is None:
        with public_response(opener, url) as response:
            require(response.code == 200 and response.geturl() == url, 'Invalid COS APK response')
            return verify_download(response, response.headers, size, digest)
    with tempfile.TemporaryDirectory(prefix='deepseek-verify-public-release-') as directory:
        apk = Path(directory) / 'package.apk'
        headers_path = Path(directory) / 'headers'
        result = subprocess.run(
            [curl, '-q', '--silent', '--noproxy', '*', '--proto', '=https', '--max-time', '120',
             '--max-filesize', str(size), '--header', 'Accept-Encoding: identity', '--header',
             'Cache-Control: no-cache', '--output', str(apk), '--dump-header', str(headers_path),
             '--write-out', '%{http_code}', '--', url],
            capture_output=True, timeout=125,
        )
        require(result.returncode == 0 and result.stdout == b'200', 'Invalid COS APK response')
        last_headers = headers_path.read_bytes().rstrip(b'\r\n').split(b'\r\n\r\n')[-1]
        status_line, _, encoded_headers = last_headers.partition(b'\r\n')
        require(re.fullmatch(rb'HTTP/\S+ 200(?: .*)?', status_line), 'Invalid COS APK headers')
        headers = http.client.parse_headers(io.BytesIO(encoded_headers + b'\r\n\r\n'))
        with apk.open('rb') as stream:
            return verify_download(stream, headers, size, digest)


def verify_apk(opener, manifest):
    version, digest, size = manifest['versionCode'], manifest['sha256'], manifest['apkSize']
    require(type(version) is int and 1 <= version <= 2147483647, 'Invalid APK version')
    require(isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest), 'Invalid APK hash')
    require(type(size) is int and 0 < size <= MAX_APK_BYTES, 'Invalid APK size')
    filename = f'deepseek-continuation-{version}.apk'
    source = f'{PUBLIC_ORIGIN}{CHANNEL}/apks/{version}/{filename}'
    mirror = f'{MIRROR_ORIGIN}/apks/{version}/{digest}/{filename}'
    require(manifest['apkUrl'] == source, 'Unexpected APK URL')
    with public_response(opener, source) as response:
        require(response.geturl() == source, 'Invalid APK response origin')
        if response.code == 200:
            return (*verify_download(response, response.headers, size, digest), source)
        require(response.code == 302, 'Invalid APK response')
        require(response.headers.get_all('Location') == [mirror], 'Unexpected APK redirect')
        require(response.headers.get('Cache-Control') == 'no-store', 'Invalid APK redirect caching')
    return (*verify_mirror(opener, mirror, size, digest), mirror)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(args.metadata.read_text(encoding='utf-8'))
    require(expected.get('signatureVerified') is True, 'Verified local APK required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
    url = f'{PUBLIC_ORIGIN}{CHANNEL}/latest.json'
    with public_response(opener, url) as response:
        require(response.code == 200 and response.geturl() == url, 'Invalid manifest response')
        require(response.headers.get('Cache-Control') == 'no-store', 'Invalid manifest caching')
        raw = response.read(32769)
        require(len(raw) <= 32768, 'Oversized manifest')
        manifest = json.loads(raw)
    for field in ('packageName', 'versionCode', 'versionName', 'minSdk'):
        require(manifest[field] == expected[field], 'Manifest identity mismatch: ' + field)
    require(manifest['sha256'] == expected['apkSha256'], 'Manifest hash mismatch')
    version = expected['versionCode']
    size, digest, downloaded_from = verify_apk(opener, manifest)
    receipt = dict(verified=True, versionCode=version, versionName=manifest['versionName'],
                   apkSize=size, sha256=digest, manifest_no_store=True, apk_immutable=True,
                   public_apk_full_download_verified=True, apk_url=downloaded_from,
                   cos_redirect_verified=downloaded_from != manifest['apkUrl'])
    args.output.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
