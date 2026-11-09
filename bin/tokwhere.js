#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listAll, filterByProject, filterByName, findById } from '../src/discover.js';
import { parseClaudeSession } from '../src/claude.js';
import { parseCodexSession } from '../src/codex.js';
import { buildReport } from '../src/report.js';
import { renderText } from '../src/format.js';
import { redact } from '../src/redact.js';

const HELP = `tokwhere - see where your coding agent's tokens went

Usage
  tokwhere                    latest session for the current folder
  tokwhere --days 7           every session from the last 7 days
  tokwhere --session <id>     one session (id or id prefix)

Options
  --days <n>        sessions active in the last n days (all projects)
  --project <p>     limit to a project: a path, "." or a folder name
  --session <id>    a Claude Code or Codex session id (prefix is fine)
  --agent <name>    claude or codex
  --top <n>         rows per section (default 8)
  --huge <tokens>   size that counts as a huge result (default 10000)
  --redact          hide project names, file names and commands
  --full-paths      show full project paths instead of folder names
  --no-subagents    leave out Claude Code subagent logs
  --json            machine-readable output
  -h, --help        show this help
  -v, --version     show the version

Reads ~/.claude/projects and ~/.codex/sessions. Nothing leaves your machine.`;

function die(msg) {
  process.stderr.write(`tokwhere: ${msg}\n`);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    options: {
      days: { type: 'string' },
      project: { type: 'string' },
      session: { type: 'string' },
      agent: { type: 'string' },
      top: { type: 'string' },
      huge: { type: 'string' },
      redact: { type: 'boolean' },
      'full-paths': { type: 'boolean' },
      'no-subagents': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  }).values;
} catch (e) {
  die(`${e.message}\nRun tokwhere --help for usage.`);
}

if (args.help) { console.log(HELP); process.exit(0); }
if (args.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (args.agent && !['claude', 'codex'].includes(args.agent)) die('--agent must be claude or codex');
const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) die(`--${name} needs a positive number`);
  return n;
};
const days = num(args.days, 'days');
const top = num(args.top, 'top');
const huge = num(args.huge, 'huge');

async function resolveProject(p) {
  if (p === undefined) return null;
  const abs = path.resolve(p);
  if (p === '.' || p.includes(path.sep) || fs.existsSync(abs)) return { dir: abs };
  return { name: p };
}

async function parse(e) {
  return e.agent === 'claude'
    ? parseClaudeSession(e.file, { subagents: !args['no-subagents'] })
    : parseCodexSession(e.file);
}

async function main() {
  let entries = listAll({ agent: args.agent });
  let mode = 'session';
  let title = '';

  if (args.session) {
    entries = findById(entries, args.session);
    if (!entries.length) die(`no session matches "${args.session}"`);
    if (entries.length > 1 && new Set(entries.map((e) => e.id)).size > 1) {
      die(`"${args.session}" matches ${entries.length} sessions; use more of the id`);
    }
    entries = entries.slice(0, 1);
  } else {
    const proj = await resolveProject(args.project ?? (days ? undefined : '.'));
    if (days) {
      const since = Date.now() - days * 86400000;
      entries = entries.filter((e) => e.mtime >= since);
      mode = 'range';
      title = `last ${days} day${days === 1 ? '' : 's'}`;
    }
    if (proj?.dir) entries = await filterByProject(entries, proj.dir);
    if (proj?.name) entries = await filterByName(entries, proj.name);
    if (!days) {
      if (!entries.length) {
        die(`no sessions found for ${proj.dir || proj.name}\nTry: tokwhere --days 7   (all projects)`);
      }
      entries = entries.slice(0, 1);
    }
  }

  const sessions = [];
  for (const e of entries) {
    try {
      const s = await parse(e);
      sessions.push(s);
    } catch (err) {
      process.stderr.write(`tokwhere: skipped ${e.file}: ${err.message}\n`);
    }
  }
  const projFilter = await resolveProject(args.project);
  if (!sessions.length) die('no sessions found' + (days ? ` in the last ${days} days` : ''));
  if (mode === 'range' && projFilter) title += ` · ${projFilter.name || path.basename(projFilter.dir)}`;

  let report = buildReport(sessions, { top, huge, fullPaths: args['full-paths'] });
  if (args.redact) report = redact(report);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(report, { mode, title, top }) + '\n');
  }
}

main().catch((e) => die(e.stack || e.message));
