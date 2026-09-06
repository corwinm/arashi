import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import winreg

root = Path(__file__).resolve().parents[2] / 'target' / 'native-alpha-evidence' / 'extracted-tester'
powershell = __import__('shutil').which('powershell.exe')
assert powershell and (root / 'arashi2-setup.exe').is_file()
results = []
def user_path():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
        try:
            return winreg.QueryValueEx(key, 'Path')
        except FileNotFoundError:
            return None

before_path = user_path()
with tempfile.TemporaryDirectory(prefix='arashi-alpha-native-') as temp:
    home = Path(temp) / ('home caf' + chr(233))
    home.mkdir()
    stable = home / '.arashi' / 'bin'
    stable.mkdir(parents=True)
    (stable / 'aw.bat').write_bytes(b'caller stable')
    shadow = Path(temp) / 'no-python'
    shadow.mkdir()
    (shadow / 'python.exe').write_bytes(b'Invalid executable fixture; must never run')
    env = {**os.environ, 'HOME': str(home), 'USERPROFILE': str(home),
           'PATH': str(shadow)}
    installer = root / 'install-alpha.ps1'
    def run(label, args, expected):
        result = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-File', str(installer), *args],
                                env=env, capture_output=True, text=True)
        assert result.returncode == expected, (label, result.returncode, result.stdout, result.stderr)
        results.append({'case': label, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    run('help argv forwarding', ['--help'], 0)
    run('missing explicit artifacts', ['install'], 1)
    run('stable override refused', ['install', '--install-dir', str(stable)], 1)
    destination = home / '.arashi-alpha'
    destination.mkdir()
    (destination / 'aw2.exe').write_bytes(b'caller alpha')
    run('unowned refresh refused', ['install', '--archive', 'missing.zip', '--checksum-file', 'missing.sha256'], 1)
    run('unowned uninstall refused', ['uninstall'], 1)
    assert (destination / 'aw2.exe').read_bytes() == b'caller alpha'
    (destination / 'aw2.exe').unlink()
    destination.rmdir()
    caller = home / 'caller'
    caller.mkdir()
    subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(destination), str(caller)], check=True, capture_output=True)
    run('junction install refused', ['install'], 1)
    run('junction uninstall refused', ['uninstall'], 1)
    os.rmdir(destination)
    assert list(caller.iterdir()) == []
    assert (stable / 'aw.bat').read_bytes() == b'caller stable'
    assert not list(home.glob('.arashi-alpha*'))
assert user_path() == before_path
print(json.dumps({'platform': os.name, 'python': __import__('sys').version, 'cases': results,
                  'stable_bytes_preserved': True, 'user_path_preserved': True,
                  'hashes': {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                             for name in ['arashi2-setup.exe', 'install-alpha.ps1']}}))
