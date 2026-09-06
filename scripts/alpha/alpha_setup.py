#!/usr/bin/env python3
"""Opt-in, local-artifact alpha lifecycle. Python 3.9+; standard library only.

No network, elevation, shell profile, registry, npm or canonical-name writes.
Ownership is closed and conservative; concurrent external writers are unsupported.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tempfile
import zipfile

LEDGER = '.arashi-alpha-ownership.json'
VERSION = re.compile(r'2\.[0-9]+\.[0-9]+-alpha\.[0-9]+\Z')
MAX_BINARY = 128 * 1024 * 1024


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


def ancestors(path):
    for parent in reversed([path, *path.parents]):
        regular(parent, directory=True)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def strict_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('Duplicate JSON property: ' + key)
            value[key] = item
        return value
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs)


def owned(destination):
    ancestors(destination)
    if set(p.name for p in destination.iterdir()) != set(names() + [LEDGER]):
        raise ValueError('Unowned/missing/extra alpha files; preserve directory for manual recovery: ' + str(destination))
    snapshot = {}
    identities = {}
    for name in names() + [LEDGER]:
        path = destination / name
        info = regular(path)
        if info.st_size > MAX_BINARY:
            raise ValueError('Oversized owned file: ' + str(path))
        snapshot[name] = path.read_bytes()
        identities[name] = (info.st_dev, info.st_ino, info.st_mode)
    value = strict_json(snapshot[LEDGER])
    if (not isinstance(value, dict) or set(value) != {'schema', 'channel', 'directory', 'platform', 'version', 'files'} or
            type(value['schema']) is not int or value['schema'] != 1 or value['channel'] != 'rust-alpha' or
            value['directory'] != str(destination) or value['platform'] != platform_id() or
            not isinstance(value['version'], str) or not VERSION.fullmatch(value['version']) or
            value['files'] != {name: digest(snapshot[name]) for name in names()}):
        raise ValueError('Alpha ownership manifest/payload mismatch; no files removed: ' + str(destination))
    root = destination.stat()
    return snapshot, identities, (root.st_dev, root.st_ino)


def remove_owned_tree(path, snapshot):
    # Exact entries only; never recursively delete caller additions or links.
    if set(p.name for p in path.iterdir()) != set(snapshot):
        raise ValueError('Recovery directory changed; preserved: ' + str(path))
    for name, data in snapshot.items():
        regular(path / name)
        if (path / name).read_bytes() != data:
            raise ValueError('Recovery payload changed; preserved: ' + str(path / name))
    for name in snapshot:
        (path / name).unlink()
    path.rmdir()


def release(archive, checksum_file):
    regular(archive)
    regular(checksum_file)
    if archive.stat().st_size > 2 * MAX_BINARY:
        raise ValueError('Oversized alpha archive')
    data = archive.read_bytes()
    expected = checksum_file.read_text(encoding='ascii')
    if expected != digest(data) + '  ' + archive.name + '\n':
        raise ValueError('Alpha archive SHA-256 mismatch or malformed checksum file')
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries = z.infolist()
        if sorted(item.filename for item in entries) != sorted(names() + ['release.json']):
            raise ValueError('Alpha archive must contain exactly the two alpha binaries and release.json')
        for item in entries:
            mode = item.external_attr >> 16
            if not stat.S_ISREG(mode) or item.file_size > MAX_BINARY or item.flag_bits & 1:
                raise ValueError('Invalid alpha archive member: ' + item.filename)
        meta = strict_json(z.read('release.json'))
        if (not isinstance(meta, dict) or set(meta) != {'schema', 'channel', 'version', 'platform'} or
                type(meta['schema']) is not int or meta['schema'] != 1 or meta['channel'] != 'rust-alpha' or
                meta['platform'] != platform_id() or not isinstance(meta['version'], str) or
                not VERSION.fullmatch(meta['version'])):
            raise ValueError('Wrong alpha release identity/platform')
        return meta, {name: z.read(name) for name in names()}


def lifecycle(args):
    home = os.environ.get('HOME' if os.name != 'nt' else 'USERPROFILE', '')
    if not home or not Path(home).is_absolute():
        raise ValueError('An absolute HOME/USERPROFILE is required')
    destination = Path(args.install_dir) if args.install_dir else Path(home) / '.arashi-alpha'
    if (not destination.is_absolute() or destination.name != '.arashi-alpha' or
            '..' in destination.parts or str(destination) != os.path.abspath(destination)):
        raise ValueError('Install directory must be an absolute, canonical path ending in .arashi-alpha')
    ancestors(destination.parent)
    lock = destination.parent / '.arashi-alpha.lock'
    lock.mkdir(mode=0o700)  # Exclusive: never remove an existing/stale lock automatically.
    stage = None
    stage_snapshot = {}
    try:
        old = owned(destination) if os.path.lexists(destination) else None
        if args.action == 'uninstall':
            if old is None:
                raise ValueError('No owned alpha installation; nothing removed')
            if owned(destination) != old:
                raise ValueError('Alpha install changed during preflight')
            # No recursive deletion and no stable/path/profile mutation.
            remove_owned_tree(destination, old[0])
            print('Removed owned Rust alpha binaries only. Manual PATH entries were not changed.')
            return
        if not args.archive or not args.checksum_file:
            raise ValueError('install requires --archive and --checksum-file; no latest/stable resolution')
        meta, payload = release(Path(args.archive), Path(args.checksum_file))
        stage = Path(tempfile.mkdtemp(prefix='.arashi-alpha-stage-', dir=destination.parent))
        for name, data in payload.items():
            with (stage / name).open('xb') as stream:
                stream.write(data)
            stage_snapshot[name] = data
            (stage / name).chmod(0o755)
        expected_version = 'arashi2 ' + meta['version'] + ' (experimental native alpha)\n'
        for name in names():
            result = subprocess.run([str(stage / name), '--version'], capture_output=True,
                                    text=True, timeout=15)
            if result.returncode != 0 or result.stdout != expected_version or result.stderr:
                raise ValueError('Alpha binary smoke test failed: ' + name)
        ledger = {'schema': 1, 'channel': 'rust-alpha', 'directory': str(destination),
                  'platform': platform_id(), 'version': meta['version'],
                  'files': {name: digest(data) for name, data in payload.items()}}
        data = json_bytes(ledger)
        with (stage / LEDGER).open('xb') as stream:
            stream.write(data)
        stage_snapshot[LEDGER] = data
        ancestors(destination.parent)
        if old is not None:
            if owned(destination) != old:
                raise ValueError('Alpha install changed during staging')
            # Reserve a sibling backup name. Never overwrite an existing directory.
            backup = Path(tempfile.mkdtemp(prefix='.arashi-alpha-backup-', dir=destination.parent))
            backup.rmdir()
            destination.rename(backup)
            try:
                stage.rename(destination)
            except BaseException:
                if not os.path.lexists(destination):
                    backup.rename(destination)
                else:
                    print('Recovery required; previous alpha retained at ' + str(backup), file=sys.stderr)
                raise
            stage = None
            remove_owned_tree(backup, old[0])
        else:
            if os.path.lexists(destination):
                raise ValueError('Destination appeared during staging')
            stage.rename(destination)
            stage = None
        owned(destination)
        print('Installed ' + expected_version.strip() + ' at ' + str(destination))
        print('No PATH/profile changes. Invoke ' + str(destination / names()[1]) +
              ' directly, or manually add this alpha-only directory to PATH.')
    finally:
        if stage is not None:
            remove_owned_tree(stage, stage_snapshot)
        lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description='Opt-in local Rust alpha setup (Python 3.9+). Never manages stable v1.')
    parser.add_argument('action', choices=['install', 'uninstall'])
    parser.add_argument('--archive')
    parser.add_argument('--checksum-file')
    parser.add_argument('--install-dir')
    args = parser.parse_args()
    try:
        lifecycle(args)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print('Alpha setup refused/failed: ' + str(error), file=sys.stderr)
        print('Manual fallback: keep stable arashi/aw unchanged. Verify the trusted alpha archive checksum, '
              'extract arashi2/aw2 into a NEW private directory, and invoke by absolute path. '
              'Preserve any reported recovery directory; do not delete an unproven manifest.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
