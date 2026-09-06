"""Real release-binary lifecycle acceptance; no downloads or real HOME writes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import warnings
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PACKAGED = ROOT / 'target' / 'alpha-distribution'
ARTIFACTS = ROOT / 'target' / 'native-alpha-evidence' / 'extracted-tester'
WINDOWS = os.name == 'nt'
SUFFIX = '.exe' if WINDOWS else ''


class AlphaDistribution(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/alpha/package.py'),
                                 '--output', str(PACKAGED)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        packaged_archive = Path(result.stdout.strip())
        bundle = PACKAGED / (packaged_archive.stem + '-tester' + ('.zip' if WINDOWS else '.tar.gz'))
        if ARTIFACTS.exists():
            shutil.rmtree(ARTIFACTS)
        ARTIFACTS.mkdir(parents=True)
        if WINDOWS:
            shell = shutil.which(os.environ.get('ALPHA_POWERSHELL', 'powershell.exe'))
            assert shell, 'Native PowerShell is required for Windows extraction acceptance'
            quote = lambda p: "'" + str(p).replace("'", "''") + "'"
            subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command',
                'Expand-Archive -LiteralPath ' + quote(bundle) + ' -DestinationPath ' + quote(ARTIFACTS)],
                check=True, env={**os.environ, 'PATH': str(ARTIFACTS / 'no-python')})
        else:
            # Native extraction proves +x survives the CI artifact transport.
            subprocess.run(['/usr/bin/tar', '-xzf', str(bundle), '-C', str(ARTIFACTS)], check=True)
        cls.archive = ARTIFACTS / packaged_archive.name
        cls.checksum = cls.archive.with_suffix('.zip.sha256')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='arashi-alpha-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve() / 'home café'
        self.home.mkdir()
        self.destination = self.home / '.arashi-alpha'
        stable = self.home / '.arashi' / 'bin'
        stable.mkdir(parents=True)
        for name in ['aw', 'arashi', '.arashi-managed-entrypoints.json']:
            (stable / name).write_text('caller-owned stable ' + name)
        (self.home / '.zshrc').write_text('caller profile\n')
        self.shell_env = {**os.environ, 'HOME': str(self.home), 'USERPROFILE': str(self.home),
                          'PATH': str(Path(self.temp.name) / 'no-python')}
        self.shell_cache_paths = set()
        if WINDOWS:
            self.shell = shutil.which(os.environ.get('ALPHA_POWERSHELL', 'powershell.exe'))
            self.assertTrue(self.shell)
            self.registry_before = self.user_environment()
            cache = Path(self.temp.name) / 'powershell-cache'
            cache.mkdir()
            self.shell_env.update(APPDATA=str(self.home / 'AppData/Roaming'),
                                  LOCALAPPDATA=str(self.home / 'AppData/Local'),
                                  PSModuleAnalysisCachePath=str(cache / 'ModuleAnalysisCache'))
            for folder in ['WindowsPowerShell', 'PowerShell']:
                profile = self.home / 'Documents' / folder / 'Microsoft.PowerShell_profile.ps1'
                profile.parent.mkdir(parents=True)
                profile.write_bytes(b'# caller profile\r\n')
            # A shell-only -File run proves which JIT cache this shell creates.
            # Its timing-dependent bytes change on every launch. Normalize only
            # these exact, observed cache files, never an AppData subtree.
            self.shell_probe = Path(self.temp.name) / 'shell-only.ps1'
            self.shell_probe.write_text('Get-Item -LiteralPath $PSCommandPath | Out-Null\n'
                                        'Start-Sleep -Milliseconds 100\nexit 0\n')
            self.run_shell_only()
            for folder in ['Microsoft/Windows/PowerShell', 'Microsoft/PowerShell']:
                candidate = self.home / 'AppData/Local' / folder / 'StartupProfileData-NonInteractive'
                if candidate.is_file():
                    self.shell_cache_paths.add(candidate)
        self.before = self.snapshot()

    @staticmethod
    def user_environment():
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                return sorted(winreg.EnumValue(key, i) for i in range(winreg.QueryInfoKey(key)[1]))
        except FileNotFoundError:
            return None

    def run_shell_only(self):
        result = subprocess.run([self.shell, '-NoProfile', '-NonInteractive', '-File', str(self.shell_probe)],
                                env=self.shell_env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def tearDown(self):
        if WINDOWS:
            self.assertEqual(self.registry_before, self.user_environment())
        self.assertEqual(self.before, self.snapshot())

    def snapshot(self):
        def value(path):
            if path in self.shell_cache_paths:
                info = path.lstat()
                return ('shell JIT cache', stat.S_IFMT(info.st_mode), info.st_nlink)
            return path.read_bytes() if path.is_file() else None
        return {str(p.relative_to(self.home)): value(p)
                for p in self.home.rglob('*') if '.arashi-alpha' not in p.parts}

    @unittest.skipUnless(WINDOWS, 'native shell startup baseline')
    def test_shell_only_matches_baseline(self):
        self.run_shell_only()
        self.assertEqual(self.before, self.snapshot())

    def test_snapshot_detects_unrelated_appdata_mutation(self):
        caller = self.home / 'AppData' / 'unexpected-installer-file'
        caller.parent.mkdir(exist_ok=True)
        caller.write_bytes(b'must not be ignored')
        self.assertNotEqual(self.before, self.snapshot())
        caller.unlink()
        if 'AppData' not in self.before:
            caller.parent.rmdir()

    def run_setup(self, *args, ok=True, archive=None, checksum=None):
        if WINDOWS:
            command = [os.environ.get('ALPHA_POWERSHELL', 'powershell.exe'), '-NoProfile',
                       '-NonInteractive', '-File', str(ARTIFACTS / 'install-alpha.ps1')]
        else:
            command = ['/bin/bash', str(ARTIFACTS / 'install-alpha.sh')]
        arguments = list(args)
        if not arguments or arguments[0] != 'uninstall':
            arguments = ['install', '--archive', str(archive or self.archive),
                         '--checksum-file', str(checksum or self.checksum), *arguments]
        env = self.shell_env.copy()
        # Only the launcher is selected before clearing PATH; setup has no runtime tools.
        if WINDOWS:
            command[0] = shutil.which(command[0]) or command[0]
        result = subprocess.run(command + arguments, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def test_bundle_is_native_only(self):
        self.assertTrue((ARTIFACTS / ('arashi2-setup' + SUFFIX)).is_file())
        self.assertEqual({p.name for p in ARTIFACTS.iterdir()},
                         {self.archive.name, self.checksum.name, 'arashi2-setup' + SUFFIX,
                          'install-alpha.sh', 'install-alpha.ps1'})
        if not WINDOWS:
            self.assertTrue(os.access(ARTIFACTS / 'arashi2-setup', os.X_OK))

    @unittest.skipIf(WINDOWS, 'Bash basename launch')
    def test_launcher_by_basename_without_runtime_path(self):
        result = subprocess.run(['/bin/bash', 'install-alpha.sh', '--help'], cwd=ARTIFACTS,
                                env={**os.environ, 'PATH': ''}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Native opt-in Rust alpha setup', result.stdout)

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
        for kind in ['traversal', 'smoke', 'platform', 'duplicate-member', 'duplicate-json', 'member-link', 'version']:
            bad = Path(self.temp.name) / 'bad.zip'
            with zipfile.ZipFile(self.archive) as source, zipfile.ZipFile(bad, 'w') as target:
                for item in source.infolist():
                    data = source.read(item)
                    if kind == 'smoke' and item.filename.startswith('aw2'):
                        data = b'not an executable'
                    if kind == 'duplicate-json' and item.filename == 'release.json':
                        data = data.replace(b'{', b'{"schema":1,', 1)
                    if kind == 'version' and item.filename == 'release.json':
                        value = json.loads(data)
                        value['version'] = '2.0.0'
                        data = json.dumps(value).encode()
                    if kind == 'member-link' and item.filename.startswith('aw2'):
                        item.external_attr = (0o120777 << 16)
                    if kind == 'platform' and item.filename == 'release.json':
                        value = json.loads(data)
                        value['platform'] = 'unsupported'
                        data = json.dumps(value).encode()
                    target.writestr(item, data)
                if kind == 'traversal':
                    target.writestr('../caller', b'bad')
                if kind == 'duplicate-member':
                    item = source.getinfo('release.json')
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore', UserWarning)
                        target.writestr(item, source.read(item))
            checksum = bad.with_suffix('.sha256')
            checksum.write_text(hashlib.sha256(bad.read_bytes()).hexdigest() + '  ' + bad.name + '\n')
            self.run_setup(archive=bad, checksum=checksum, ok=False)
            self.assertEqual(original, {p.name: p.read_bytes() for p in self.destination.iterdir()})
        self.assertEqual(self.before, self.snapshot())

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
        bundle = PACKAGED / (self.archive.stem + '-tester' + ('.zip' if WINDOWS else '.tar.gz'))
        bundle_before = bundle.read_bytes()
        subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/alpha/package.py'),
                        '--output', str(PACKAGED)], check=True, capture_output=True)
        self.assertEqual(before, (PACKAGED / self.archive.name).read_bytes())
        self.assertEqual(bundle_before, bundle.read_bytes())

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
        for data in [original.replace(b'{', b'{"schema":1,', 1),
                     original.replace(b'"files":{', b'"files":{"extra":"no",', 1),
                     original.replace(b'"files":{', b'"files":{"' + ('aw2' + SUFFIX).encode() + b'":"duplicate",', 1)]:
            manifest.write_bytes(data)
            self.run_setup(ok=False)
            self.run_setup('uninstall', ok=False)
            self.assertEqual(manifest.read_bytes(), data)
        manifest.write_bytes(original)
        self.run_setup('uninstall')

    def test_failed_promotion_rolls_back_previous_release(self):
        # The native unit seam injects only rename; real release archive/ownership
        # and filesystem operations are used. There is no production fault flag.
        result = subprocess.run(['cargo', 'test', '--locked', '--release', '--bin',
                                 'arashi2-setup', 'failed_promotion_restores_real_old_directory',
                                 '--', '--nocapture'], cwd=ROOT, capture_output=True, text=True,
                                env={**os.environ, 'ALPHA_TEST_ARCHIVE': str(self.archive),
                                     'ALPHA_TEST_CHECKSUM': str(self.checksum)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('real release rollback verified', result.stdout)

    def test_legacy_python_created_install_refresh_and_remove(self):
        # Development-only historical oracle: exact base commit, never bundled.
        baseline = ROOT / 'target/native-alpha-evidence/python-baseline/scripts/alpha/alpha_setup.py'
        if not baseline.exists():
            baseline.parent.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(['git', 'show',
                '932f449c3d872145eb9b6a7043421bff7b5eed3f:scripts/alpha/alpha_setup.py'],
                cwd=ROOT, capture_output=True, check=True)
            baseline.write_bytes(result.stdout)
        for refresh in [False, True]:
            result = subprocess.run([sys.executable, '-B', str(baseline), 'install',
                '--archive', str(self.archive), '--checksum-file', str(self.checksum)],
                env={**os.environ, 'HOME': str(self.home), 'USERPROFILE': str(self.home)},
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            old = json.loads((self.destination / '.arashi-alpha-ownership.json').read_bytes())
            if refresh:
                self.run_setup()
                self.assertEqual(old, json.loads((self.destination / '.arashi-alpha-ownership.json').read_bytes()))
            self.run_setup('uninstall')
            self.assertFalse(self.destination.exists())

    def test_missing_helper_has_no_path_or_interpreter_fallback(self):
        isolated = Path(self.temp.name) / 'incomplete'
        isolated.mkdir()
        shadow = Path(self.temp.name) / 'shadow'
        shadow.mkdir()
        marker = Path(self.temp.name) / 'fallback-ran'
        if WINDOWS:
            launcher = 'install-alpha.ps1'
            command = [shutil.which(os.environ.get('ALPHA_POWERSHELL', 'powershell.exe')),
                       '-NoProfile', '-NonInteractive', '-File']
            for name in ['python.exe', 'python3.exe', 'node.exe', 'arashi2-setup.exe']:
                (shadow / name).write_bytes(b'invalid executable must not be selected')
        else:
            launcher = 'install-alpha.sh'
            command = ['/bin/bash']
            for name in ['python', 'python3', 'node', 'arashi2-setup']:
                path = shadow / name
                path.write_text('#!/bin/bash\nprintf ran > "' + str(marker) + '"\nexit 88\n')
                path.chmod(0o755)
        shutil.copyfile(ARTIFACTS / launcher, isolated / launcher)
        result = subprocess.run(command + [str(isolated / launcher), '--help'],
            env={**os.environ, 'PATH': str(shadow)}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing or unsafe native arashi2-setup', result.stderr)
        self.assertFalse(marker.exists())
        if not WINDOWS:
            helper = isolated / 'arashi2-setup'
            shutil.copyfile(ARTIFACTS / helper.name, helper)
            helper.chmod(0o644)
            result = subprocess.run(command + [str(isolated / launcher), '--help'],
                env={**os.environ, 'PATH': str(shadow)}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Missing or unsafe native arashi2-setup', result.stderr)
            self.assertFalse(marker.exists())

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

    def test_packaged_parser_keeps_identity_and_blocks_stable_dispatch(self):
        self.run_setup()
        for name in ['aw2', 'arashi2']:
            binary = str(self.destination / (name + SUFFIX))
            env = {**os.environ, 'HOME': str(self.home), 'USERPROFILE': str(self.home),
                   'PATH': str(Path(self.temp.name) / 'no-runtime')}
            for args in [['--', 'shell', 'init', 'bash'], ['--', 'completion', 'bash'],
                         ['--', 'completion', '__query', '0', 'aw'], ['--', 'update'],
                         ['--', 'uninstall']]:
                result = subprocess.run([binary, *args], env=env, cwd=self.home,
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, args)
                self.assertEqual(result.stdout, '')
                self.assertIn('Use the separate alpha setup bundle', result.stderr)
            for args in [['--help'], ['help', 'create'], ['--help', '--version']]:
                result = subprocess.run([binary, *args], env=env, cwd=self.home,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('arashi2', result.stdout)
                self.assertNotIn('Usage: aw ', result.stdout)
                self.assertNotIn('$ arashi ', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
