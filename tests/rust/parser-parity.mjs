// Retained-source process oracle. Run with node ... BINARY REPORT [--capture-help].
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const binary = resolve(process.argv[2]);
const source = process.env.ARASHI_TS_SOURCE ?? resolve('src/index.ts');
const contract = JSON.parse(readFileSync(new URL('../../contracts/cli-commands.json', import.meta.url)));
const cwd = mkdtempSync(join(tmpdir(), 'arashi-parser-'));
const home = join(cwd, 'home'); mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
delete env.ARASHI_DIRECTIVE_FILE;
const run = (sourceMode, args) => {
  const p = spawnSync(sourceMode ? process.execPath : binary, sourceMode ? [source, ...args] : args, { cwd, env, encoding: 'utf8', timeout: 30000 });
  if (p.error || p.status === null) throw p.error ?? Error('process terminated');
  return { status: p.status, stdout: p.stdout, stderr: p.stderr };
};
const results = [];
const helps = {};
try {
  const commands = ['', ...contract.commands.map(c => c.path)];
  for (const command of commands) {
    const args = [...command.split(' ').filter(Boolean), '--help'];
    // Internal query intentionally disables help and interprets literal words.
    if (command === 'completion __query') continue;
    const expected = run(true, args);
    if (expected.status !== 0) throw Error(JSON.stringify({command, expected}));
    helps[command] = expected.stdout;
  }
  if (process.argv.includes('--capture-help')) {
    writeFileSync(new URL('../../src/rust/parser-help.json', import.meta.url), JSON.stringify(helps, null, 2) + '\n');
  }
  const cases = [
    ...Object.keys(helps).flatMap(c => [[...c.split(' ').filter(Boolean), '--help'], ['help', ...c.split(' ').filter(Boolean)]]),
    [], ['shell'], ['help', 'absent'], ['absent'], ['--absent'],
    ['install', 'extra', '-j'], ['create'], ['add'], ['install', 'one', 'two', '-j'],
    ['shell', 'absent'], ['shell', 'init', 'invalid', '-h'], ['shell', 'init', 'bash', 'extra', '-h'],
    ['list', '--max-depth'], ['create', '--base'], ['create', '--conflict', 'bad'],
    ['init', '--ignore-scope', 'bad'], ['list', '--json=true'], ['list', '-jx'],
    ['list', '--absent', '--help'], ['list', '--max-depth', '--help'],
    ['--help', 'list'], ['--absent', 'list', '--help'], ['install', '-j', '--', '--help'],
    ['create', '-nh'], ['create', '--base=main', '-h'], ['create', '--base', '-h'],
    ['create', '--base', '--help', '-h'], ['create', '-ofoo', '-h'], ['create', '-o=foo', '-h'],
    ['status', '-jv'], ['status', '-jsv'], ['status', '-jj'],
    ['status', '-j', '-oone', '--only', 'two'], ['status', '--only=-foo', '-j'],
    ['create', '--no-launch', '--launch', '-h'], ['create', '--launch', '--no-launch', '-h'],
    ['shell', 'help', 'init'], ['shell', '--help', 'init'], ['completion', 'invalid'],
    ['list', '-hV'], ['list', '-Vh'], ['--version', 'absent'],
    ['completion', '__query'], ['completion', '__query', '2', '--', 'arashi', 'status', '--help'],
    ['completion', '__query', '2', 'arashi', 'status', '--help'],
    ['stats'], ['status', '--jsno'], ['shell', 'instal'],
    ...['1e2', '1.0', '+1', ' 1', '', '9007199254740992', '0003'].map(v => ['list', `--max-depth=${v}`, '-h']),
  ];
  if (!process.argv.includes('--capture-help')) for (const args of cases) {
    const expected = run(true, args), actual = run(false, args);
    // Version is intentionally owned by the Rust package, not retained package.json.
    if (expected.status === 0 && /^\d+\.\d+\.\d+[^\n]*\n$/.test(expected.stdout)) expected.stdout = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version === expected.stdout.trim() ? readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf8').match(/^version = "([^"]+)"/m)[1] + '\n' : expected.stdout;
    const equal = JSON.stringify(expected) === JSON.stringify(actual);
    results.push({ args, expected, actual, equal });
    console.log(`${equal ? 'PASS' : 'DIFF'} ${JSON.stringify(args)}`);
  }
} finally {
  writeFileSync(resolve(process.argv[3]), JSON.stringify({ source, results }, null, 2) + '\n');
  if (JSON.stringify(readdirSync(cwd)) !== JSON.stringify(['home']) || readdirSync(home).length) throw Error('Parser invocation mutated disposable cwd/HOME');
  rmSync(cwd, { recursive: true, force: true });
}
if (results.some(r => !r.equal)) process.exitCode = 1;
