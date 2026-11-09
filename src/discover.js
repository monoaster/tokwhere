// Find session log files for Claude Code and Codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexMeta } from './codex.js';

export function roots(env = process.env) {
  return {
    claude: env.TOKWHERE_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects'),
    codex: env.TOKWHERE_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions'),
  };
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readdirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

// Claude Code names a project folder after its cwd with every non-alphanumeric
// character turned into "-".
export function claudeDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function listClaude(root) {
  const out = [];
  for (const d of readdirSafe(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of readdirSafe(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      const st = statSafe(file);
      if (!st || st.size === 0) continue;
      out.push({ agent: 'claude', file, mtime: st.mtimeMs, dirName: d.name, id: f.name.slice(0, -6) });
    }
  }
  return out;
}

export function listCodex(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of readdirSafe(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = statSafe(p);
        if (!st || st.size === 0) continue;
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(e.name);
        out.push({ agent: 'codex', file: p, mtime: st.mtimeMs, id: m ? m[1] : e.name.slice(0, -6) });
      }
    }
  };
  walk(root, 0);
  return out;
}

export function listAll({ agent, env } = {}) {
  const r = roots(env);
  const list = [];
  if (!agent || agent === 'claude') list.push(...listClaude(r.claude));
  if (!agent || agent === 'codex') list.push(...listCodex(r.codex));
  return list.sort((a, b) => b.mtime - a.mtime);
}

function headCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch {
    return null;
  }
}

function under(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Keep only entries whose session cwd is the project dir or inside it.
export async function filterByProject(entries, projectDir) {
  const enc = claudeDirName(projectDir);
  const out = [];
  for (const e of entries) {
    if (e.agent === 'claude') {
      if (e.dirName === enc) out.push(e);
      else if (e.dirName.startsWith(enc + '-')) {
        // Could be a subfolder or a sibling like "app-v2"; check the logged cwd.
        const cwd = headCwd(e.file);
        if (cwd && under(cwd, projectDir)) out.push(e);
      }
    } else {
      if (e.cwd === undefined) {
        try { e.cwd = (await codexMeta(e.file)).cwd ?? null; } catch { e.cwd = null; }
      }
      if (e.cwd && under(e.cwd, projectDir)) out.push(e);
    }
  }
  return out;
}

export function findById(entries, id) {
  const q = id.toLowerCase();
  const exact = entries.filter((e) => e.id.toLowerCase() === q);
  if (exact.length) return exact;
  return entries.filter((e) => e.id.toLowerCase().startsWith(q) || path.basename(e.file).toLowerCase().includes(q));
}

// Keep only entries whose session cwd has this folder name.
export async function filterByName(entries, name) {
  const out = [];
  for (const e of entries) {
    if (e.agent === 'claude') {
      if (!e.dirName.endsWith('-' + name.replace(/[^a-zA-Z0-9]/g, '-'))) continue;
      e.cwd = e.cwd ?? headCwd(e.file);
    } else if (e.cwd === undefined) {
      try { e.cwd = (await codexMeta(e.file)).cwd ?? null; } catch { e.cwd = null; }
    }
    if (e.cwd && path.basename(e.cwd) === name) out.push(e);
  }
  return out;
}
