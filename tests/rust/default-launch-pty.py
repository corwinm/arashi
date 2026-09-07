"""Real controlling-PTY source/native consumer acceptance (POSIX)."""
import errno, json, os, pathlib, pty, select, signal, subprocess, sys, tempfile, time
launcher=sys.argv[1:]
results=[]
for case in ['switch-select','switch-cancel','switch-all-select','create-select','create-cancel','create-none','create-filtered']:
    with tempfile.TemporaryDirectory(prefix='arashi-consumer-pty-') as temp:
        root=pathlib.Path(temp).resolve()/'workspace'; root.mkdir()
        home=root.parent/'home'; home.mkdir()
        env={'HOME':str(home),'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(home/'gitconfig'),'TERM':'xterm-256color','NO_COLOR':'1','ARASHI_SHELL':'bash','ARASHI_DIRECTIVE_FILE':str(home/'directive')}
        def git(at,*args):
            return subprocess.run(['git',*args],cwd=at,env=env,capture_output=True,text=True,check=True).stdout
        def init(at):
            at.mkdir(parents=True,exist_ok=True); git(at,'init','-b','main'); (at/'seed').write_text('seed\n'); git(at,'add','seed'); git(at,'-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','seed')
        init(root); children=[root/'repos'/name for name in ['api','zeta']]
        for child in children: init(child)
        (root/'.arashi').mkdir(); config=root/'.arashi/config.json'
        config.write_text(json.dumps({'version':'1.0.0','reposDir':'repos','worktreesDir':'.arashi/worktrees','repos':{p.name:{'path':str(p.relative_to(root))} for p in children}}))
        if case.startswith('switch'): git(root,'worktree','add','-b','topic',str(root.parent/'topic'))
        refs=[git(p,'show-ref') for p in [root,*children]]; config_bytes=config.read_bytes()
        args=['switch','--cd'] if case.startswith('switch') else ['create','topic','--interactive','--no-hooks']
        if case=='switch-all-select': args.append('--all')
        if case=='create-filtered': args.extend(['--only','zeta'])
        marker=b'Select a worktree to switch to:' if case.startswith('switch') else b'Select child repositories to create worktrees in:'
        keys=b'\x03' if case.endswith('cancel') else (b'\x1b[B\r' if case.startswith('switch') else b' \r')
        if case in ['switch-all-select','create-none']: keys=b'\r'
        pid,fd=pty.fork()
        if pid==0:
            import fcntl, struct, termios
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
            os.chdir(root); os.execve(launcher[0],launcher+args,env)
        stream=b''; sent=False; status=None; deadline=time.monotonic()+20
        try:
            while time.monotonic()<deadline:
                if select.select([fd],[],[],0.05)[0]:
                    try: block=os.read(fd,65536)
                    except OSError as error:
                        if error.errno==errno.EIO: block=b''
                        else: raise
                    stream+=block
                    if marker in stream and not sent:
                        os.write(fd,keys); sent=True
                done,observed=os.waitpid(pid,os.WNOHANG)
                if done: status=observed; break
            if status is None:
                os.kill(pid,signal.SIGKILL); _,status=os.waitpid(pid,0)
        finally: os.close(fd)
        exit_code=os.waitstatus_to_exitcode(status)
        after=[git(p,'show-ref') for p in [root,*children]]
        directive=(home/'directive').read_text() if (home/'directive').exists() else None
        expected_exit = 2 if case=='create-cancel' else 0
        valid=sent and exit_code==expected_exit and config.read_bytes()==config_bytes
        if case.endswith('cancel'): valid=valid and refs==after and directive is None
        elif case=='switch-all-select': valid=valid and refs==after and directive=="cd -- '"+str(root)+"'\n"
        elif case=='create-none': valid=valid and 'refs/heads/topic' in after[0] and after[1:]==refs[1:] and directive is None
        elif case=='create-filtered': valid=valid and 'refs/heads/topic' in after[0] and 'refs/heads/topic' in after[2] and after[1]==refs[1] and directive is None
        elif case=='switch-select': valid=valid and refs==after and directive=="cd -- '"+str(root.parent/'topic')+"'\n"
        else: valid=valid and 'refs/heads/topic' in after[0] and 'refs/heads/topic' in after[1] and after[2]==refs[2] and directive is None
        results.append({'case':case,'passed':valid,'prompt_seen':sent,'exit':exit_code,'output':stream.decode(errors='replace').replace(str(root.parent),'<FIXTURE>'),'directive':directive.replace(str(root.parent),'<FIXTURE>') if directive else None})
print(json.dumps(results,indent=2)); sys.exit(0 if all(r['passed'] for r in results) else 1)
