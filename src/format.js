// Plain terminal rendering of a report.
import { fmtNum, fmtCompact, fmtDuration, shortPath, oneLine } from './util.js';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = wrap('1');
const dim = wrap('2');
const yellow = wrap('33');

const est = (n) => '~' + fmtCompact(n);

const vlen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, w, right) => {
  const gap = ' '.repeat(Math.max(0, w - vlen(s)));
  return right ? gap + s : s + gap;
};

function table(rows, aligns) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, vlen(c)); });
  return rows.map((r) => '  ' + r.map((c, i) => {
    const s = String(c);
    if (i === r.length - 1 && aligns[i] !== 'r') return s;
    return pad(s, widths[i], aligns[i] === 'r');
  }).join('  ').trimEnd());
}

function fmtDate(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function wasteLine(w) {
  switch (w.kind) {
    case 'reread': return `${shortPath(w.file, w.cwd)} re-read ${w.rereads}× unchanged`;
    case 'fanout': return `${shortPath(w.file, w.cwd)} read ${w.reads}× by ${w.agents} subagents`;
    case 'failing': return `\`${oneLine(w.cmd, 44)}\` failed ${w.count}×`;
    case 'huge': return w.count === 1
      ? `1 tool result over ${fmtCompact(w.threshold)} tokens`
      : `${w.count} tool results over ${fmtCompact(w.threshold)} tokens each`;
    default: return w.kind;
  }
}

export function renderText(r, { title, mode, top = 10 }) {
  const out = [];
  const u = r.usage;
  if (mode === 'session') {
    const s = r.sessions[0];
    out.push(`${bold('tokwhere')}  ${s.agent} · ${s.project} · ${String(s.id).slice(0, 8)}`);
    const bits = [`${fmtDate(s.start)} → ${fmtDate(s.end)} (${fmtDuration(s.end - s.start)})`];
    if (s.models.length) bits.push(s.models[0] + (s.models.length > 1 ? ` +${s.models.length - 1}` : ''));
    bits.push(`${s.toolCalls} tool calls`);
    if (s.subagents) bits.push(`${s.subagents} subagent${s.subagents > 1 ? 's' : ''}`);
    out.push(dim('          ' + bits.join(' · ')));
  } else {
    const ag = Object.entries(r.agents).map(([a, n]) => `${n} ${a}`).join(', ');
    out.push(`${bold('tokwhere')}  ${title} · ${r.sessions.length} sessions (${ag}) · ${r.projects.length} projects`);
  }
  out.push('');

  const allEst = r.sessions.every((s) => s.usageEstimated);
  const n = (v) => (allEst ? '~' : '') + fmtNum(v);
  out.push(bold(allEst ? 'TOKENS  (no usage data in the log; rough floor from message sizes)'
    : r.usageEstimated ? 'TOKENS  (from usage fields; some sessions estimated)'
    : 'TOKENS  (from the logs\' usage fields)'));
  out.push(...table([
    ['input', n(u.input)],
    ['cache write', n(u.cacheWrite)],
    ['cache read', n(u.cacheRead)],
    ['output', n(u.output)],
    ['total', n(u.total)],
  ], ['l', 'r']));
  out.push('');

  if (mode !== 'session' && r.projects.length > 1) {
    out.push(bold('PROJECTS'));
    out.push(...table([
      [dim('project'), dim('sessions'), dim('tokens'), dim('tool results')],
      ...r.projects.slice(0, top).map((p) => [p.project, p.sessions, fmtCompact(p.tokens), est(p.resultTokens)]),
    ], ['l', 'r', 'r', 'r']));
    if (r.projects.length > top) out.push(dim(`  … ${r.projects.length - top} more`));
    out.push('');
  }

  out.push(bold(`TOOL RESULTS  ${est(r.resultTokens)} tokens put into context (estimated)`));
  if (!r.tools.length) out.push(dim('  no tool calls'));
  else {
    out.push(...table([
      [dim('tool'), dim('calls'), dim('failed'), dim('tokens')],
      ...r.tools.slice(0, top).map((t) => [oneLine(t.tool, 30), t.calls, t.errors || '', est(t.tokens)]),
    ], ['l', 'r', 'r', 'r']));
  }
  out.push('');

  if (r.files.length) {
    out.push(bold('FILES READ MOST'));
    out.push(...table([
      [dim('reads'), dim('unchanged'), dim('tokens'), dim('file')],
      ...r.files.map((f) => [`${f.reads}×`, f.rereads || '', est(f.tokens), oneLine(shortPath(f.file, f.cwd), 50)]),
    ], ['r', 'r', 'r', 'l']));
    out.push('');
  }

  if (r.biggest.length) {
    out.push(bold('BIGGEST SINGLE RESULTS'));
    out.push(...table(r.biggest.map((b) => [
      est(b.tokens),
      oneLine(b.tool, 26),
      oneLine(shortPath(b.label, b.cwd) || '', 52) + (mode === 'session' ? '' : dim(`  [${b.project}]`)),
    ]), ['r', 'l', 'l']));
    out.push('');
  }

  out.push(bold('WASTE'));
  if (!r.waste.length) out.push(dim('  nothing stood out'));
  else out.push(...table(r.waste.map((w) => [yellow(est(w.tokens).padStart(6)), wasteLine(w)]), ['l', 'l']));
  out.push('');
  out.push(dim('~ = estimate (characters / 4).' + (allEst ? '' : ' Token totals come from the logged usage fields.')));
  return out.join('\n');
}
