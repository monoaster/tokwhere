import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseClaudeSession } from '../src/claude.js';
import { parseCodexSession, codexCommands, patchedFiles } from '../src/codex.js';
import { buildReport } from '../src/report.js';
import { redact } from '../src/redact.js';
import { normalizeCommand, filesReadByCommand, shellWords, fmtCompact, tildify } from '../src/util.js';
import { claudeDirName, filterByProject } from '../src/discover.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures');
const BIN = path.join(here, '..', 'bin', 'tokwhere.js');
const CLAUDE_FILE = path.join(FX, 'claude', '-tmp-fake-my-app', 'aaaa1111-0000-4000-8000-000000000001.jsonl');
const CODEX_FILE = path.join(FX, 'codex', '2026', '01', '02', 'rollout-2026-01-02T12-00-00-0c0d0e0f-1111-4222-8333-444455556666.jsonl');

// Copy fixtures to a temp dir and make them look recent, for --days tests.
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function freshFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokwhere-test-'));
  tmpDirs.push(dir);
  fs.cpSync(FX, dir, { recursive: true });
  const now = new Date();
  const touch = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) touch(q); else fs.utimesSync(q, now, now);
    }
  };
  touch(dir);
  return dir;
}

function run(args, dir, cwd = os.tmpdir()) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', TOKWHERE_CLAUDE_DIR: path.join(dir, 'claude'), TOKWHERE_CODEX_DIR: path.join(dir, 'codex') },
  });
}

test('normalizeCommand drops cd, env, 2>&1 and trailing tail/grep', () => {
  assert.equal(normalizeCommand('cd /a/b && npm test 2>&1 | tail -20'), 'npm test');
  assert.equal(normalizeCommand('FOO=1 BAR="x y" npm test'), 'npm test');
  assert.equal(normalizeCommand('export A=1 && cd x; pytest -q | grep FAIL'), 'pytest -q');
  assert.equal(normalizeCommand('npm test; echo done'), 'npm test && echo done');
  assert.equal(normalizeCommand('timeout 60 npm test'), 'npm test');
});

test('filesReadByCommand finds files given to cat/head/sed', () => {
  assert.deepEqual(filesReadByCommand('cat a.txt b.txt'), ['a.txt', 'b.txt']);
  assert.deepEqual(filesReadByCommand("sed -n '1,200p' src/x.js"), ['src/x.js']);
  assert.deepEqual(filesReadByCommand('head -n 50 README.md | grep foo'), ['README.md']);
  assert.deepEqual(filesReadByCommand('npm test && tail -5 log.txt'), ['log.txt']);
  assert.deepEqual(filesReadByCommand('ls -la'), []);
  assert.deepEqual(filesReadByCommand('cat *.md'), []);
});

test('shellWords handles quotes', () => {
  assert.deepEqual(shellWords(`a "b c" 'd e' f\\ g`), ['a', 'b c', 'd e', 'f g']);
});

test('helpers: compact numbers, home shortening, claude dir names', () => {
  assert.equal(fmtCompact(950), '950');
  assert.equal(fmtCompact(12345), '12k');
  assert.equal(fmtCompact(1234), '1.2k');
  assert.equal(fmtCompact(4900000), '4.9M');
  assert.equal(fmtCompact(9990), '10k');
  assert.equal(fmtCompact(999.9), '1.0k');
  assert.equal(tildify(path.join(os.homedir(), 'x')), '~/x');
  assert.equal(claudeDirName('/tmp/fake/my-app'), '-tmp-fake-my-app');
});

test('claude parser: usage counted once per message, subagents included', async () => {
  const s = await parseClaudeSession(CLAUDE_FILE);
  assert.equal(s.agent, 'claude');
  assert.equal(s.id, 'aaaa1111-0000-4000-8000-000000000001');
  assert.equal(s.cwd, '/tmp/fake/my-app');
  assert.equal(s.subagents, 1);
  assert.deepEqual(s.usage, { input: 63, cacheWrite: 1500, cacheRead: 14500, output: 300 });
  assert.equal(s.usageEstimated, false);
  assert.equal(s.badLines, 1);
  assert.equal(s.calls.length, 11);
  const noSub = await parseClaudeSession(CLAUDE_FILE, { subagents: false });
  assert.equal(noSub.usage.input, 60);
});

test('claude parser: errors and user rejections', async () => {
  const s = await parseClaudeSession(CLAUDE_FILE);
  const bash = s.calls.filter((c) => c.tool === 'Bash');
  assert.deepEqual(bash.map((c) => c.isError), [true, true, false, false]);
  const read = s.calls.find((c) => c.id === 't1');
  assert.equal(read.tokens, 1000);
});

test('codex parser: usage from the largest cumulative record', async () => {
  const s = await parseCodexSession(CODEX_FILE);
  assert.equal(s.agent, 'codex');
  assert.equal(s.id, '0c0d0e0f-1111-4222-8333-444455556666');
  assert.equal(s.cwd, '/tmp/fake/my-app');
  assert.deepEqual(s.usage, { input: 2000, cacheWrite: 0, cacheRead: 4000, output: 80 });
  assert.deepEqual(s.models, ['gpt-test']);
  assert.equal(s.calls.length, 5);
  assert.deepEqual(s.calls.map((c) => c.isError), [false, false, true, false, true]);
  assert.deepEqual(s.calls[3].writes, ['/tmp/fake/my-app/src/index.js']);
  assert.equal(s.calls[3].tool, 'apply_patch');
  assert.equal(s.calls[0].tool, 'exec_command');
});

test('codex helpers pull commands and patched files', () => {
  assert.deepEqual(codexCommands('tools.exec_command({cmd:"ls \\"a b\\"",max:1})'), ['ls "a b"']);
  assert.deepEqual(codexCommands('{"command":["bash","-lc","npm test"]}'), ['npm test']);
  assert.deepEqual(patchedFiles('*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: b.js\n'), ['a.md', 'b.js']);
});

test('report: re-reads, failing commands, huge results', async () => {
  const s = await parseClaudeSession(CLAUDE_FILE);
  const r = buildReport([s]);
  const pkg = r.files.find((f) => f.file.endsWith('package.json'));
  assert.equal(pkg.reads, 5);
  assert.equal(pkg.rereads, 3, 'edit in the middle resets; cat counts as a full read');
  const failing = r.waste.find((w) => w.kind === 'failing');
  assert.equal(failing.cmd, 'npm test');
  assert.equal(failing.count, 2);
  const huge = r.waste.find((w) => w.kind === 'huge');
  assert.equal(huge.count, 1);
  assert.equal(r.biggest[0].tool, 'mcp:docs/search');
  assert.equal(r.biggest[0].tokens, 12000);
  assert.equal(r.tools[0].tool, 'mcp:docs/search');
  assert.equal(r.usage.total, 63 + 1500 + 14500 + 300);
});

test('report: sessions from both agents add up', async () => {
  const a = await parseClaudeSession(CLAUDE_FILE);
  const b = await parseCodexSession(CODEX_FILE);
  const r = buildReport([a, b]);
  assert.deepEqual(r.agents, { claude: 1, codex: 1 });
  assert.equal(r.usage.input, 63 + 2000);
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].project, 'my-app');
  assert.equal(r.waste.find((w) => w.kind === 'failing').count, 4);
});

test('report: same file read by many subagents is flagged', () => {
  const call = (ctx) => ({ tool: 'Read', label: '/p/big.md', cmd: null, reads: ['/p/big.md'], writes: [], tokens: 3000, isError: false, ctx, range: '::' });
  const s = {
    agent: 'claude', id: 'x', cwd: '/p', start: 0, end: 1, models: [], subagents: 3,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, usageEstimated: false,
    calls: [call('main'), call('a1'), call('a2'), call('a3')],
  };
  const r = buildReport([s]);
  const w = r.waste.find((x) => x.kind === 'fanout');
  assert.equal(w.agents, 3);
  assert.equal(w.tokens, 12000);
  assert.equal(r.waste.find((x) => x.kind === 'reread'), undefined, 'separate contexts are not re-reads');
});

test('redact hides project, file and command names', async () => {
  const s = await parseClaudeSession(CLAUDE_FILE);
  const r = redact(buildReport([s]));
  const text = JSON.stringify(r);
  assert.ok(!text.includes('my-app'));
  assert.ok(!text.includes('package.json'));
  assert.equal(r.sessions[0].project, 'project-1');
  assert.equal(r.waste.find((w) => w.kind === 'failing').cmd, 'npm test …');
});

test('filterByProject skips sibling folders that share a prefix', async () => {
  const entries = [
    { agent: 'claude', dirName: '-tmp-fake-my-app', file: CLAUDE_FILE },
    { agent: 'claude', dirName: '-tmp-fake-my-app-v2', file: path.join(FX, 'claude', '-tmp-fake-my-app-v2', 'bbbb2222-0000-4000-8000-000000000002.jsonl') },
    { agent: 'codex', file: CODEX_FILE },
  ];
  const out = await filterByProject(entries, '/tmp/fake/my-app');
  assert.equal(out.length, 2);
  assert.ok(!out.some((e) => e.dirName === '-tmp-fake-my-app-v2'));
});

test('cli: --session prints the text report', () => {
  const dir = freshFixtures();
  const r = run(['--session', 'aaaa1111'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tokwhere {2}claude · my-app · aaaa1111/);
  assert.match(r.stdout, /package\.json re-read 3× unchanged/);
  assert.match(r.stdout, /`npm test` failed 2×/);
  assert.match(r.stdout, /total\s+16,363/);
  for (const line of r.stdout.split('\n')) assert.ok(line.length <= 100, `line too wide: ${line}`);
});

test('cli: --days with --json covers both agents', () => {
  const dir = freshFixtures();
  const r = run(['--days', '1', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.sessions.length, 3);
  assert.deepEqual(j.agents, { claude: 2, codex: 1 });
  assert.equal(j.projects.length, 2);
});

test('cli: --project by folder name and --agent', () => {
  const dir = freshFixtures();
  const r = run(['--days', '1', '--project', 'my-app', '--agent', 'codex', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.sessions.length, 1);
  assert.equal(j.sessions[0].agent, 'codex');
});

test('cli: no sessions for this folder gives a hint and exit 1', () => {
  const dir = freshFixtures();
  const r = run([], dir, os.tmpdir());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--days 7/);
});

test('cli: bad flags fail cleanly', () => {
  const dir = freshFixtures();
  assert.equal(run(['--days', 'abc'], dir).status, 1);
  assert.equal(run(['--agent', 'gpt'], dir).status, 1);
  assert.equal(run(['--nope'], dir).status, 1);
  const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage/);
});
