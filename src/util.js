import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

// Rough token estimate: about 4 characters per token for English and code.
export function estTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Images are sent as base64 but billed by pixel count. We do not decode them,
// so we use a flat guess for a typical screenshot.
export const IMAGE_TOKENS = 1600;

export function tildify(p) {
  if (!p) return p;
  if (p === HOME) return '~';
  if (p.startsWith(HOME + path.sep)) return '~' + p.slice(HOME.length);
  return p;
}

export function shortPath(p, cwd) {
  if (!p) return '';
  if (cwd && (p === cwd || p.startsWith(cwd + path.sep))) {
    return path.relative(cwd, p) || '.';
  }
  return tildify(p);
}

export function resolvePath(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (path.isAbsolute(p)) return path.normalize(p);
  return cwd ? path.resolve(cwd, p) : p;
}

// Minimal shell word splitter: handles single/double quotes and backslashes.
export function shellWords(s) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = ''; has = false;
      continue;
    }
    cur += c; has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

// Split a shell command line on && || ; | and newlines (outside quotes).
export function shellSegments(cmd) {
  const segs = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) segs.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

const READERS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'less', 'more', 'bat']);

// Files a shell command reads whole (cat, head, sed -n, nl ...). Heuristic.
export function filesReadByCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];
  const files = [];
  for (const seg of shellSegments(cmd)) {
    const w = shellWords(seg);
    while (w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[0])) w.shift();
    if (!w.length) continue;
    const prog = path.basename(w[0]);
    if (!READERS.has(prog)) continue;
    let skipScript = prog === 'sed';
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a.startsWith('>') || a.startsWith('<') || /^\d?>/.test(a)) { i++; continue; }
      if (a.startsWith('-')) {
        if (prog === 'sed' && (a === '-e' || a === '-f')) { skipScript = false; i++; }
        else if ((prog === 'head' || prog === 'tail') && (a === '-n' || a === '-c')) i++;
        continue;
      }
      if (skipScript) { skipScript = false; continue; }
      if (/^[+]?\d+$/.test(a)) continue;
      if (a.includes('*')) continue;
      files.push(a);
    }
  }
  return files;
}

// Split on top-level && and ; (outside quotes), keeping the pieces' text.
function topLevelChain(cmd) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || (c === '&' && cmd[i + 1] === '&')) {
      if (c === '&') i++;
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

const SETUP = /^(cd|export|source|\.|set|unset|pushd)\s|^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

// Collapse a shell command so trivial variations count as the same command.
export function normalizeCommand(cmd) {
  if (!cmd) return '';
  let parts = topLevelChain(String(cmd).trim().replace(/\s+/g, ' '));
  while (parts.length > 1 && SETUP.test(parts[0])) parts.shift();
  let c = parts.join(' && ');
  c = c.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*) )+/, '');
  c = c.replace(/^(?:timeout|gtimeout) (?:-\S+ )*\d+[smh]? /, '');
  c = c.replace(/ ?2>&1/g, '');
  c = c.replace(/( ?\| ?(head|tail|grep|less|cat|tee)\b[^|]*)+$/, '');
  return c.trim();
}

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtCompact(n) {
  const a = Math.abs(n);
  for (const [div, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (a >= div * 0.9995) {
      const v = n / div;
      return (Math.abs(v) >= 9.95 ? v.toFixed(0) : v.toFixed(1)) + unit;
    }
  }
  return String(Math.round(n));
}

export function fmtDuration(ms) {
  if (!(ms > 0)) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

export function oneLine(s, max = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// A read key: whole-file reads (Read with no range, cat) share one key so a
// cat after a Read still counts as a re-read.
export function readRange(cmd) {
  const n = normalizeCommand(cmd);
  return /^(cat|bat|less|more) [^|&;<>]+$/.test(n) ? '::' : n;
}
