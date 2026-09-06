#!/usr/bin/env python3
"""Package host-built native alpha aliases; no release/tag/network operations."""
import argparse
from pathlib import Path
import re
import shutil
import stat
import subprocess
import zipfile
import hashlib
import json
import os
import platform
import gzip
import tarfile

VERSION = re.compile(r'2\.[0-9]+\.[0-9]+-alpha\.[0-9]+\Z')


def platform_id():
    system = {'Darwin': 'macos', 'Linux': 'linux', 'Windows': 'windows'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    if not system or not arch or (system == 'windows' and arch != 'x64'):
        raise ValueError('Unsupported alpha platform; build the Rust alpha aliases manually.')
    return system + '-' + arch


def names():
    suffix = '.exe' if os.name == 'nt' else ''
    return ['arashi2' + suffix, 'aw2' + suffix]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, directory=False):
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode) or
            getattr(info, 'st_file_attributes', 0) & 0x400 or
            not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) or
            (not directory and info.st_nlink != 1)):
        raise ValueError('Linked, reparse, special or hardlinked path refused: ' + str(path))
    return info


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')




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
    helper = 'arashi2-setup' + ('.exe' if os.name == 'nt' else '')
    helper_path = args.binary_dir.resolve() / helper
    regular(helper_path)
    result = subprocess.run([str(helper_path), '--version'], capture_output=True, text=True, check=True)
    if result.stdout != 'arashi2-setup ' + version + '\n' or result.stderr:
        raise ValueError('Wrong native setup identity')
    shutil.copy2(helper_path, args.output / helper)
    for name in ['install-alpha.sh', 'install-alpha.ps1']:
        shutil.copyfile(Path(__file__).parent / name, args.output / name)
    # GitHub artifact upload strips executable bits: publish a nested mode-preserving
    # tester archive, not loose executables. Payload ZIP remains the lifecycle input.
    members = [archive.name, archive.name + '.sha256', helper, 'install-alpha.sh', 'install-alpha.ps1']
    bundle = args.output / (archive.stem + '-tester' + ('.zip' if os.name == 'nt' else '.tar.gz'))
    candidate = bundle.with_name(bundle.name + '.tmp')
    try:
        if os.name == 'nt':
            with zipfile.ZipFile(candidate, 'w', compression=zipfile.ZIP_DEFLATED) as output:
                for name in sorted(members):
                    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | (0o755 if name in [helper, 'install-alpha.sh'] else 0o644)) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    output.writestr(info, (args.output / name).read_bytes())
        else:
            with candidate.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode='w|') as output:
                    for name in sorted(members):
                        info = tarfile.TarInfo(name)
                        info.size = (args.output / name).stat().st_size
                        info.mode = 0o755 if name in [helper, 'install-alpha.sh'] else 0o644
                        with (args.output / name).open('rb') as stream:
                            output.addfile(info, stream)
        candidate.replace(bundle)
    finally:
        candidate.unlink(missing_ok=True)
    bundle.with_name(bundle.name + '.sha256').write_text(digest(bundle.read_bytes()) + '  ' + bundle.name + '\n', encoding='ascii')
    print(archive)


if __name__ == '__main__':
    main()
