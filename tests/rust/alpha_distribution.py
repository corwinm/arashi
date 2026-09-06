"""Real release-binary lifecycle acceptance; no downloads or real HOME writes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / 'target' / 'alpha-distribution'
WINDOWS = os.name == 'nt'
SUFFIX = '.exe' if WINDOWS else ''


class AlphaDistribution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/alpha/package.py'),
                                 '--output', str(ARTIFACTS)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        cls.archive = Path(result.stdout.strip())
        cls.checksum = cls.archive.with_suffix('.zip.sha256')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='arashi-alpha-')
        self.home = Path(self.temp.name).resolve() / 'home café'
        self.home.mkdir()
        self.destination = self.home / '.arashi-alpha'
        stable = self.home / '.arashi' / 'bin'
        stable.mkdir(parents=True)
        for name in ['aw', 'arashi', '.arashi-managed-entrypoints.json']:
            (stable / name).write_text('caller-owned stable ' + name)
        (self.home / '.zshrc').write_text('caller profile\n')
        self.before = self.snapshot()

    def tearDown(self):
        self.assertEqual(self.before, self.snapshot())
        self.temp.cleanup()

    def snapshot(self):
        return {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*')
                if p.is_file() and '.arashi-alpha' not in p.parts}

    def run_setup(self, *args, ok=True, archive=None, checksum=None):
        if WINDOWS:
            command = [os.environ.get('ALPHA_POWERSHELL', 'powershell.exe'), '-NoProfile',
                       '-NonInteractive', '-File', str(ARTIFACTS / 'install-alpha.ps1')]
        else:
            command = ['bash', str(ARTIFACTS / 'install-alpha.sh')]
        arguments = list(args)
        if not arguments or arguments[0] != 'uninstall':
            arguments = ['install', '--archive', str(archive or self.archive),
                         '--checksum-file', str(checksum or self.checksum), *arguments]
        env = {**os.environ, 'HOME': str(self.home), 'USERPROFILE': str(self.home)}
        result = subprocess.run(command + arguments, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def test_install_refresh_remove(self):
        self.run_setup()
        for name in ['aw2', 'arashi2']:
            version = subprocess.check_output([str(self.destination / (name + SUFFIX)), '--version'], text=True)
            self.assertRegex(version, r'^arashi2 2\.\d+\.\d+-alpha\.\d+ \(experimental native alpha\)\n$')
        original = {p.name: p.read_bytes() for p in self.destination.iterdir()}
        self.run_setup()
        self.assertEqual(original, {p.name: p.read_bytes() for p in self.destination.iterdir()})
        self.run_setup('uninstall')
        self.assertFalse(self.destination.exists())

    def test_unowned_directory_is_not_adopted(self):
        self.destination.mkdir()
        (self.destination / ('aw2' + SUFFIX)).write_text('caller')
        self.run_setup(ok=False)
        self.run_setup('uninstall', ok=False)
        self.assertEqual((self.destination / ('aw2' + SUFFIX)).read_text(), 'caller')

    def test_modified_payload_refuses_refresh_and_removal(self):
        self.run_setup()
        binary = self.destination / ('aw2' + SUFFIX)
        binary.write_bytes(b'caller modified')
        self.run_setup(ok=False)
        self.run_setup('uninstall', ok=False)
        self.assertEqual(binary.read_bytes(), b'caller modified')

    def test_extra_file_and_malformed_manifest_preserved(self):
        self.run_setup()
        extra = self.destination / 'caller.txt'
        extra.write_text('caller')
        self.run_setup(ok=False)
        self.run_setup('uninstall', ok=False)
        extra.unlink()
        ledger = self.destination / '.arashi-alpha-ownership.json'
        ledger.write_bytes(b'\xff')
        self.run_setup('uninstall', ok=False)
        self.assertEqual(ledger.read_bytes(), b'\xff')

    def test_checksum_failure_has_no_install_effect(self):
        checksum = Path(self.temp.name) / 'bad.sha256'
        checksum.write_text('0' * 64 + '  ' + self.archive.name + '\n')
        self.run_setup(checksum=checksum, ok=False)
        self.assertFalse(self.destination.exists())

    def test_invalid_archive_and_failed_smoke_preserve_old_install(self):
        self.run_setup()
        original = {p.name: p.read_bytes() for p in self.destination.iterdir()}
        for kind in ['traversal', 'smoke', 'platform']:
            bad = Path(self.temp.name) / 'bad.zip'
            with zipfile.ZipFile(self.archive) as source, zipfile.ZipFile(bad, 'w') as target:
                for item in source.infolist():
                    data = source.read(item)
                    if kind == 'smoke' and item.filename.startswith('aw2'):
                        data = b'not an executable'
                    if kind == 'platform' and item.filename == 'release.json':
                        value = json.loads(data)
                        value['platform'] = 'unsupported'
                        data = json.dumps(value).encode()
                    target.writestr(item, data)
                if kind == 'traversal':
                    target.writestr('../caller', b'bad')
            checksum = bad.with_suffix('.sha256')
            checksum.write_text(hashlib.sha256(bad.read_bytes()).hexdigest() + '  ' + bad.name + '\n')
            self.run_setup(archive=bad, checksum=checksum, ok=False)
            self.assertEqual(original, {p.name: p.read_bytes() for p in self.destination.iterdir()})
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ['.arashi', '.arashi-alpha', '.zshrc'])

    @unittest.skipIf(WINDOWS, 'Windows junction coverage runs separately')
    def test_linked_destination_and_payload_preserved(self):
        caller = Path(self.temp.name) / 'caller'
        caller.mkdir()
        self.destination.symlink_to(caller, target_is_directory=True)
        self.run_setup(ok=False)
        self.run_setup('uninstall', ok=False)
        self.assertTrue(self.destination.is_symlink())
        self.destination.unlink()
        self.run_setup()
        binary = self.destination / ('aw2' + SUFFIX)
        binary.unlink()
        binary.symlink_to(caller / 'missing')
        self.run_setup('uninstall', ok=False)
        self.assertTrue(binary.is_symlink())

    def test_hardlinked_payload_is_preserved(self):
        self.run_setup()
        binary = self.destination / ('aw2' + SUFFIX)
        caller = Path(self.temp.name) / 'caller-hardlink'
        os.link(binary, caller)
        original = caller.read_bytes()
        self.run_setup(ok=False)
        self.run_setup('uninstall', ok=False)
        self.assertEqual(caller.read_bytes(), original)
        self.assertEqual(binary.read_bytes(), original)

    def test_stable_destination_override_refused(self):
        self.run_setup('--install-dir', str(self.home / '.arashi/bin'), ok=False)
        self.run_setup('uninstall', '--install-dir', str(self.home / '.arashi/bin'), ok=False)
        self.assertFalse(self.destination.exists())

    def test_packaging_is_reproducible(self):
        before = self.archive.read_bytes()
        subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/alpha/package.py'),
                        '--output', str(ARTIFACTS)], check=True, capture_output=True)
        self.assertEqual(before, self.archive.read_bytes())

    def test_lock_and_forged_ownership_fail_closed(self):
        lock = self.home / '.arashi-alpha.lock'
        lock.mkdir()
        self.run_setup(ok=False)
        self.assertTrue(lock.is_dir())
        lock.rmdir()
        self.run_setup()
        manifest = self.destination / '.arashi-alpha-ownership.json'
        original = manifest.read_bytes()
        for key, value in [('schema', True), ('channel', 'stable'),
                           ('directory', str(self.home)), ('extra', 'unowned')]:
            data = json.loads(original)
            data[key] = value
            manifest.write_text(json.dumps(data))
            self.run_setup(ok=False)
            self.run_setup('uninstall', ok=False)
            self.assertEqual(json.loads(manifest.read_bytes()), data)
        manifest.write_bytes(original)
        self.run_setup('uninstall')

    def test_failed_promotion_rolls_back_previous_release(self):
        # Narrow syscall failure injection; real release bytes and filesystem operations.
        import importlib.util
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('alpha_setup', ROOT / 'scripts/alpha/alpha_setup.py')
        assert spec is not None and spec.loader is not None
        setup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(setup)
        self.run_setup()
        original = {p.name: p.read_bytes() for p in self.destination.iterdir()}
        rename = Path.rename
        def fail_promotion(path, target):
            if path.name.startswith('.arashi-alpha-stage-'):
                raise OSError('injected promotion failure')
            return rename(path, target)
        from argparse import Namespace
        args = Namespace(action='install', archive=str(self.archive), checksum_file=str(self.checksum),
                         install_dir=str(self.destination))
        with patch.object(Path, 'rename', fail_promotion):
            with self.assertRaisesRegex(OSError, 'injected promotion failure'):
                setup.lifecycle(args)
        self.assertEqual(original, {p.name: p.read_bytes() for p in self.destination.iterdir()})
        self.assertFalse(list(self.home.glob('.arashi-alpha-*')))

    @unittest.skipUnless(WINDOWS, 'native Windows junction acceptance')
    def test_windows_junction_is_never_adopted(self):
        caller = Path(self.temp.name) / 'caller'
        caller.mkdir()
        subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(self.destination), str(caller)],
                       check=True, capture_output=True)
        try:
            self.run_setup(ok=False)
            self.run_setup('uninstall', ok=False)
            self.assertEqual(list(caller.iterdir()), [])
        finally:
            os.rmdir(self.destination)

    def test_alias_does_not_enable_stable_shell_or_updater(self):
        self.run_setup()
        for command in ['update', 'uninstall', 'install', 'shell', 'shell-init', 'completion']:
            result = subprocess.run([str(self.destination / ('aw2' + SUFFIX)), command],
                                    capture_output=True, text=True,
                                    env={**os.environ, 'HOME': str(self.home)})
            self.assertNotEqual(result.returncode, 0, command)
            self.assertIn('Use the separate alpha setup bundle', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
