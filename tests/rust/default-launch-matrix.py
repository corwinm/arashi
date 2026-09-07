"""Source/native policy and process oracle. Fixture tools never open user GUIs."""
import json, os, pathlib, subprocess, sys, tempfile
launcher=sys.argv[1:]
# case, command, defaults, extra environment
cases=[
 ('create-default-none',['create','topic','--no-hooks'],{},{}),
 ('create-auto-ide',['create','topic','--no-hooks'],{'create':{'launch':'auto'}},{'TERM_PROGRAM':'vscode'}),
 ('create-auto-suppressed',['create','topic','--no-hooks','--no-launch'],{'create':{'launch':'auto'}},{'TERM_PROGRAM':'vscode'}),
 ('create-editor-host',['create','topic','--no-hooks','--editor-host','cursor'],{'create':{'launch':'none'},'editors':{'cursor':{'create':{'launch':'auto'}}}},{'TERM_PROGRAM':'vscode'}),
 ('create-editor-host-no-fallback',['create','topic','--no-hooks','--editor-host','cursor'],{'create':{'launch':'auto'}},{'TERM_PROGRAM':'vscode'}),
 ('create-switch-guidance',['create','topic','--no-hooks','--switch'],{},{}),
 ('create-tmux-context',['create','topic','--no-hooks','--tmux'],{},{}),
 ('create-tmux',['create','topic','--no-hooks','--tmux'],{},{'TMUX':'fixture'}),
 ('create-launch-wins',['create','topic','--no-hooks','--launch','--no-launch'],{},{'TERM_PROGRAM':'vscode'}),
 ('create-tab-preflight',['create','topic','--no-hooks','--tab'],{},{'TERM_PROGRAM':'Apple_Terminal'}),
 ('create-tab-dry',['create','topic','--no-hooks','--tab','--dry-run'],{},{'TERM_PROGRAM':'Apple_Terminal'}),
 ('switch-cd',['switch','main','--cd'],{},{}),
 ('switch-auto-cd',['switch','main'],{'switch':{'mode':'auto'}},{}),
 ('switch-auto-managed',['switch','main'],{'switch':{'mode':'auto'}},{'TMUX':'fixture'}),
 ('switch-default-launch',['switch','main'],{},{'TERM_PROGRAM':'vscode'}),
 ('switch-config-sesh',['switch','main','--launch'],{'switch':{'mode':'sesh'}},{'TMUX':'fixture'}),
 ('switch-bypass-sesh',['switch','main','--ignore-configured-launcher'],{'switch':{'mode':'sesh'}},{'TERM_PROGRAM':'vscode'}),
 ('switch-tab-bypass-herdr',['switch','main','--tab'],{'switch':{'mode':'herdr'}},{'TERM_PROGRAM':'WezTerm','WEZTERM_PANE':'4'}),
 ('switch-tmux',['switch','main','--tmux'],{},{'TMUX':'fixture'}),
 ('switch-sesh',['switch','main','--sesh'],{},{'TMUX':'fixture'}),
 ('switch-herdr',['switch','main','--herdr'],{},{}),
 ('switch-herdr-tab',['switch','main','--herdr','--tab'],{},{'HERDR_WORKSPACE_ID':'fixture'}),
 ('switch-cmux',['switch','main'],{},{'CMUX_WORKSPACE_ID':'fixture'}),
 ('switch-ide',['switch','main','--cursor'],{},{}),
 ('switch-terminal',['switch','main'],{},{'TERM_PROGRAM':'Apple_Terminal'}),
 ('switch-kitty',['switch','main'],{},{'KITTY_PID':'1234'}),
 ('create-launch-failure',['create','topic','--no-hooks','--launch'],{},{'TERM_PROGRAM':'vscode','FAIL_LAUNCH':'1'}),
]
fixture_tool='''#!/usr/bin/python3
import json, os, pathlib, sys
name=pathlib.Path(sys.argv[0]).name
with open(os.environ['CANARY'],'a') as f: f.write(json.dumps({'tool':name,'cwd':os.getcwd(),'argv':sys.argv[1:],'inherited':os.environ.get('ARASHI_FIXTURE_LITERAL')})+'\\n')
if os.environ.get('FAIL_LAUNCH')=='1': sys.exit(7)
if name=='herdr':
 print(json.dumps({'result':{'type':'worktree_opened','already_open':False,'workspace':{'workspace_id':'fixture'},'tab':{'tab_id':'tab','root_pane_id':'pane'}}}))
elif name=='cmux': print(json.dumps({'workspace_id':'fixture'}))
elif name=='kitten':
 state=pathlib.Path(os.environ['CANARY']+'.kitty')
 if '--version' in sys.argv: print('kitten 0.48.2')
 elif 'launch' in sys.argv:
  marker=sys.argv[sys.argv.index('--var')+1].split('=',1)[1]; cwd=sys.argv[sys.argv.index('--cwd')+1]
  state.write_text(json.dumps([{'id':1,'tabs':[{'id':2,'windows':[{'id':42,'cwd':cwd,'is_focused':True,'last_focused_at':0,'session_name':'workspace: main','title':'fixture','user_vars':{'arashi_worktree_id':marker}}]}]}])); print('42')
 elif 'ls' in sys.argv: print(state.read_text() if state.exists() else '[]')
'''
results=[]
for name,args,defaults,extra in cases:
 with tempfile.TemporaryDirectory(prefix='arashi-launch-matrix-') as temp:
  root=pathlib.Path(temp).resolve()/'workspace'; root.mkdir(); home=root.parent/'home'; home.mkdir(); binpath=root.parent/'bin'; binpath.mkdir()
  env={'HOME':str(home),'PATH':str(binpath),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(home/'gitconfig'),'CANARY':str(home/'launch'),'ARASHI_SHELL':'bash','ARASHI_DIRECTIVE_FILE':str(home/'directive'),'NO_COLOR':'1','ARASHI_FIXTURE_LITERAL':"literal $ ; ' env",**extra}
  for utility in ['git', 'which']:
   (binpath/utility).symlink_to('/usr/bin/'+utility)
  def git(*argv): return subprocess.run(['git',*argv],cwd=root,env=env,capture_output=True,text=True,check=True).stdout
  git('init','-b','main'); (root/'seed').write_text('seed\n'); git('add','seed'); git('-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','seed')
  (root/'.arashi').mkdir(); config=root/'.arashi/config.json'; config.write_text(json.dumps({'version':'1.0.0','reposDir':'repos','worktreesDir':'.arashi/worktrees','repos':{},'defaults':defaults}))
  for tool in ['code','cursor','kiro','tmux','sesh','herdr','cmux','wezterm','open','osascript','kitten']:
   p=binpath/tool; p.write_text(fixture_tool); p.chmod(0o755)
  before=config.read_bytes()
  try:
   o=subprocess.run(launcher+args,cwd=root,env=env,capture_output=True,text=True,timeout=30)
  except subprocess.TimeoutExpired as error:
   o=subprocess.CompletedProcess(launcher+args,124,(error.stdout or b'').decode(),(error.stderr or b'').decode())
  print(name+': '+str(o.returncode), file=sys.stderr)
  norm=lambda s:s.replace(str(root.parent),'<FIXTURE>')
  calls=[json.loads(norm(line)) for line in (home/'launch').read_text().splitlines()] if (home/'launch').exists() else []
  assert all(call['inherited'] == "literal $ ; ' env" for call in calls), 'child environment was not inherited'
  # Only normalize the root-derived identity after checking its real digest.
  import hashlib
  expected_identity='arashi_worktree_id=arashi-v1-'+hashlib.sha256(str(root).encode()).hexdigest()
  for call in calls:
   call['argv']=[('<ROOT_IDENTITY>' if value==expected_identity else value) for value in call['argv']]
  results.append({'case':name,'exit':o.returncode,'stdout':norm(o.stdout),'stderr':norm(o.stderr),'branches':git('branch','--format=%(refname)').splitlines(),'calls':calls,'directive':norm((home/'directive').read_text()) if (home/'directive').exists() else None,'config_unchanged':config.read_bytes()==before})
print(json.dumps(results,indent=2))
