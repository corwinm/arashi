import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(process.env.ARASHI_PROMPT_NODE_MODULES ? resolve(process.env.ARASHI_PROMPT_NODE_MODULES, '../package.json') : import.meta.url);
const pty = require('node-pty');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const source = args.includes('--source') ? resolve(option('--source')) : null;
const binary = source ? process.execPath : resolve(option('--binary'));
const rows = [
  ['arrows', 'Choose item', '\x1b[B\x1b[A\x1b[B\r'], ['wrap', 'Choose item', 'k\r'],
  ['cancel-select', 'Choose item', '\x03'], ['cancel-multi', 'Choose items', '\x03'],
  ['cancel-confirm', 'Proceed', '\x03'], ['panic-restore', 'Enter text', '\r'],
  ['existing-raw', 'Enter text', 'ok\r'],
  ['select', 'Choose item', 'j\r'], ['default-select', 'Choose item', '\r'],
  ['multi', 'Choose items', 'j k \r'], ['empty-multi', 'Choose items', '\r'],
  ['input', 'Enter text', 'jké\r'], ['default-input', 'Enter text', '\r'],
  ['validate', 'Enter text', 'bad\r', 'Try again', '\u007f\u007f\u007fok\r'],
  ['confirm', 'Proceed', '\r'], ['yes', 'Proceed', '\r'],
  ['cancel', 'Enter text', '\u0003'], ['eof', 'Enter text', '\u0004'],
  ['empty-select', 'PROMPT_RESULT_OK', ''],
];
const results = [];
for (const [id, token, keys, retryToken, retryKeys] of rows) {
  if (source && ['validate', 'eof', 'empty-select', 'empty-multi', 'arrows', 'wrap', 'cancel-select', 'cancel-multi', 'cancel-confirm', 'panic-restore', 'existing-raw'].includes(id)) continue;
  const home = mkdtempSync(join(tmpdir(), 'arashi-prompt-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, ARASHI_PROMPT_CASE: id, TERM: 'xterm-256color' };
    delete env.ARASHI_DIRECTIVE_FILE; delete env.ARASHI_SHELL;
    const argv = source ? [resolve(import.meta.dirname, 'prompt-source.mjs'), source] : ['--exact', 'prompt_fixture', '--nocapture'];
    const child = pty.spawn(binary, argv, { name: 'xterm-256color', cols: 100, rows: 30, cwd: home, env, useConpty: true });
    let output = '', stage = 0, timedOut = false;
    const result = await new Promise((accept, reject) => {
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
      const settlement = setTimeout(() => reject(new Error(`${id}: PTY child failed to settle after kill\n${output}`)), 20000);
      child.onData(data => {
        output += data;
        if (stage === 0 && output.includes(token)) { stage = 1; child.write(keys); }
        if (stage === 1 && retryToken && output.includes(retryToken)) { stage = 2; child.write(retryKeys); }
        if (stage < 3 && output.includes('Reuse terminal')) { stage = 3; child.write('reuse\r'); }
      });
      child.onExit(event => { clearTimeout(timer); clearTimeout(settlement); accept({ id, ...event, timedOut, output }); });
    });
    results.push(result);
    if (args.includes('--report')) writeFileSync(resolve(option('--report')), JSON.stringify(results, null, 2));
    assert.equal(timedOut, false, `${id}: deadline\n${output}`);
    assert.equal(result.exitCode, 0, `${id}\n${output}`);
    assert.match(output, /PROMPT_RESULT_OK/);
    assert.match(output, /REUSE_OK/);
    if (id === 'select') assert.match(output, /description/);
    console.log(`PASS ${source ? 'source' : 'native'} ${id}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
if (args.includes('--report')) writeFileSync(resolve(option('--report')), JSON.stringify(results, null, 2));
console.log(`${results.length} PTY cases passed (${process.platform === 'win32' ? 'ConPTY' : 'POSIX PTY'})`);
