"""Disposable retained-source/native command oracle; no real GUI or HOME writes."""
import json, os, pathlib, subprocess, tempfile, sys
repo = pathlib.Path(__file__).resolve().parents[2]
launcher = sys.argv[1:]
results = []
for name, args, defaults in [
    ('ordinary-create', ['create', 'topic', '--no-hooks'], {}),
    ('configured-json', ['create', 'topic', '--json', '--no-hooks'], {'create': {'launch': 'auto', 'switch': False}}),
    ('tmux-context', ['switch', 'main', '--tmux'], {}),
    ('explicit-ide', ['switch', 'main', '--vscode'], {}),
    *[(f'standalone-{flag}', ['create', 'topic', flag, '--no-hooks', '--no-launch', '--no-switch'], {}) for flag in ['--interactive', '--only=workspace', '--group=unused']],
]:
    with tempfile.TemporaryDirectory(prefix='arashi-default-oracle-') as temp:
        root = pathlib.Path(temp).resolve() / 'workspace'; root.mkdir()
        home = root.parent / 'home'; home.mkdir()
        binpath = root.parent / 'bin'; binpath.mkdir()
        env = {'HOME':str(home), 'PATH':str(binpath)+':/usr/bin:/bin', 'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':str(home/'gitconfig'), 'CANARY':str(home/'launch'), 'NO_COLOR':'1'}
        def git(*argv):
            return subprocess.run(['git',*argv], cwd=root, env=env, capture_output=True, text=True, check=True).stdout
        git('init','-b','main'); (root/'seed').write_text('seed\n'); git('add','seed'); git('-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','seed')
        if name.startswith('standalone-'):
            (root/'.worktrees').mkdir(); (root/'.git/info/exclude').write_text('.worktrees/\n')
        else:
            (root/'.arashi').mkdir(); (root/'.arashi/config.json').write_text(json.dumps({'version':'1.0.0','reposDir':'repos','worktreesDir':'.arashi/worktrees','repos':{},'defaults':defaults}))
        code=binpath/'code'; code.write_text('#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@" > "$CANARY"\n'); code.chmod(0o755)
        process=subprocess.run(launcher+args,cwd=root,env=env,capture_output=True,text=True,timeout=25)
        def normalized(s): return s.replace(str(root.parent),'<FIXTURE>')
        results.append({'case':name,'exit':process.returncode,'stdout':normalized(process.stdout),'stderr':normalized(process.stderr),'branches':git('branch','--format=%(refname)').splitlines(),'launch':normalized((home/'launch').read_text()) if (home/'launch').exists() else None,'home_files':sorted(p.name for p in home.iterdir())})
print(json.dumps(results,indent=2))
