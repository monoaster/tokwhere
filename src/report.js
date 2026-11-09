// Turn parsed sessions into a report: totals, tools, files, biggest results, waste.
import path from 'node:path';
import { normalizeCommand, shortPath, tildify, oneLine } from './util.js';
import { toolDisplayName } from './claude.js';

export const DEFAULTS = { top: 8, huge: 10000 };

function projectName(cwd, fullPaths) {
  if (!cwd) return '(unknown)';
  return fullPaths ? tildify(cwd) : path.basename(cwd) || cwd;
}

// Pair each command in a call with its own exit code when we can.
function commandOutcomes(call) {
  const cmds = call.cmds || (call.cmd ? [call.cmd] : []);
  if (!cmds.length) return [];
  if (call.exitCodes && call.exitCodes.length === cmds.length) {
    return cmds.map((c, i) => ({ cmd: c, failed: call.exitCodes[i] !== 0 }));
  }
  if (cmds.length === 1) return [{ cmd: cmds[0], failed: call.isError }];
  // Several commands but we can't tell which one failed: blame the last.
  return cmds.map((c, i) => ({ cmd: c, failed: call.isError && i === cmds.length - 1 }));
}

export function buildReport(sessions, opts = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const tools = new Map();
  const files = new Map();
  const fails = new Map();
  const results = [];
  const projects = new Map();
  let usageEstimated = false;
  let resultTokens = 0;

  for (const s of sessions) {
    for (const k of Object.keys(usage)) usage[k] += s.usage[k] || 0;
    if (s.usageEstimated) usageEstimated = true;
    const proj = projectName(s.cwd, o.fullPaths);
    const sTotal = s.usage.input + s.usage.cacheWrite + s.usage.cacheRead + s.usage.output;
    let sResults = 0;

    const edits = new Map(); // file -> edit count in this session
    const lastRead = new Map(); // file|range -> edit count when last read

    for (const c of s.calls) {
      const name = toolDisplayName(c.tool);
      const t = tools.get(name) || { tool: name, calls: 0, errors: 0, tokens: 0 };
      t.calls++;
      if (c.isError) t.errors++;
      t.tokens += c.tokens;
      tools.set(name, t);
      resultTokens += c.tokens;
      sResults += c.tokens;
      results.push({ tokens: c.tokens, tool: name, label: c.cmd ? oneLine(normalizeCommand(c.cmd), 70) : c.label, cwd: s.cwd, project: proj, session: s.id, agent: s.agent });

      for (const w of c.writes) edits.set(w, (edits.get(w) || 0) + 1);

      if (c.reads.length) {
        const share = c.tokens / c.reads.length;
        const range = c.range ?? normalizeCommand(c.cmd);
        for (const r of c.reads) {
          const key = s.agent + '\0' + r;
          const f = files.get(key) || { file: r, cwd: s.cwd, reads: 0, rereads: 0, tokens: 0, rereadTokens: 0 };
          f.reads++;
          f.tokens += share;
          if (c.ctx && c.ctx !== 'main') (f.subCtx ||= new Set()).add(s.id + c.ctx);
          const rk = (c.ctx || '') + '\0' + r + '\0' + range;
          const ec = edits.get(r) || 0;
          if (!c.isError && lastRead.has(rk) && lastRead.get(rk) === ec) {
            f.rereads++;
            f.rereadTokens += share;
          }
          if (!c.isError) lastRead.set(rk, ec);
          files.set(key, f);
        }
      }

      for (const { cmd, failed } of commandOutcomes(c)) {
        if (!failed) continue;
        const n = normalizeCommand(cmd);
        if (!n) continue;
        const key = n;
        const f = fails.get(key) || { cmd: n, count: 0, tokens: 0, project: proj };
        f.count++;
        f.tokens += c.tokens / Math.max(1, (c.cmds || [c.cmd]).length);
        fails.set(key, f);
      }
    }

    const p = projects.get(proj) || { project: proj, sessions: 0, tokens: 0, resultTokens: 0, agents: new Set() };
    p.sessions++;
    p.tokens += sTotal;
    p.resultTokens += sResults;
    p.agents.add(s.agent);
    projects.set(proj, p);
  }

  const toolList = [...tools.values()].sort((a, b) => b.tokens - a.tokens);
  const fileList = [...files.values()].sort((a, b) => b.reads - a.reads || b.tokens - a.tokens);
  results.sort((a, b) => b.tokens - a.tokens);
  const biggest = results.slice(0, o.top);

  // Waste: a few of each kind, so cheap-but-telling items (failing commands)
  // are not pushed out by big ones.
  const rereads = fileList
    .filter((f) => f.rereads >= 2 || (f.rereads >= 1 && f.rereadTokens >= 5000))
    .sort((a, b) => b.rereadTokens - a.rereadTokens)
    .slice(0, 3)
    .map((f) => ({ kind: 'reread', tokens: f.rereadTokens, file: f.file, cwd: f.cwd, reads: f.reads, rereads: f.rereads }));
  const failing = [...fails.values()]
    .filter((f) => f.count >= 2)
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens)
    .slice(0, 3)
    .map((f) => ({ kind: 'failing', tokens: f.tokens, cmd: f.cmd, count: f.count }));
  const fanout = fileList
    .filter((f) => f.subCtx && f.subCtx.size >= 3 && f.tokens >= 5000)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 2)
    .map((f) => ({ kind: 'fanout', tokens: f.tokens, file: f.file, cwd: f.cwd, reads: f.reads, agents: f.subCtx.size }));
  const huge = results.filter((r) => r.tokens >= o.huge);
  const waste = [...rereads, ...fanout, ...failing];
  if (huge.length) {
    waste.push({ kind: 'huge', tokens: huge.reduce((a, r) => a + r.tokens, 0), count: huge.length, threshold: o.huge });
  }

  const agents = {};
  for (const s of sessions) agents[s.agent] = (agents[s.agent] || 0) + 1;

  return {
    sessions: sessions.map((s) => ({
      agent: s.agent,
      id: s.id,
      project: projectName(s.cwd, o.fullPaths),
      cwd: s.cwd,
      start: s.start,
      end: s.end,
      models: s.models,
      subagents: s.subagents,
      usage: s.usage,
      usageEstimated: s.usageEstimated,
      toolCalls: s.calls.length,
    })),
    agents,
    usage: { ...usage, total: usage.input + usage.cacheWrite + usage.cacheRead + usage.output },
    usageEstimated,
    resultTokens,
    tools: toolList,
    files: fileList.slice(0, o.top).map(({ subCtx, ...f }) => ({ ...f, subagents: subCtx ? subCtx.size : 0, tokens: Math.round(f.tokens), rereadTokens: Math.round(f.rereadTokens) })),
    biggest,
    waste: waste.map((w) => ({ ...w, tokens: Math.round(w.tokens) })),
    projects: [...projects.values()]
      .map((p) => ({ ...p, agents: [...p.agents] }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

export { shortPath, oneLine };
