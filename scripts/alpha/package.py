#!/usr/bin/env python3
"""Package host-built native alpha aliases; no release/tag/network operations."""
import argparse
from pathlib import Path
import re
import shutil
import stat
import subprocess
import zipfile
from alpha_setup import VERSION, digest, json_bytes, names, platform_id, regular

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--binary-dir', type=Path, default=ROOT / 'target/release')
    args = parser.parse_args()
    match = re.search(r'^version = "([^"]+)"$', (ROOT / 'Cargo.toml').read_text(), re.M)
    if match is None:
        raise ValueError("Missing Cargo version")
    version = match[1]
    if not VERSION.fullmatch(version):
        raise ValueError('Only explicit 2.x Rust alpha versions may be packaged')
    payload = {}
    for name in names():
        path = args.binary_dir.resolve() / name
        regular(path)
        result = subprocess.run([str(path), '--version'], capture_output=True, text=True, check=True)
        if result.stdout != 'arashi2 ' + version + ' (experimental native alpha)\n' or result.stderr:
            raise ValueError('Not a native alpha binary: ' + str(path))
        payload[name] = path.read_bytes()
    payload['release.json'] = json_bytes({'schema': 1, 'channel': 'rust-alpha',
                                          'version': version, 'platform': platform_id()})
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / ('arashi2-' + version + '-' + platform_id() + '.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o644 if name == 'release.json' else 0o755)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, data)
    archive.with_suffix('.zip.sha256').write_bytes((digest(archive.read_bytes()) + '  ' + archive.name + '\n').encode('ascii'))
    for name in ['alpha_setup.py', 'install-alpha.sh', 'install-alpha.ps1']:
        shutil.copyfile(Path(__file__).parent / name, args.output / name)
    print(archive)


if __name__ == '__main__':
    main()
