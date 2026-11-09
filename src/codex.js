// Parser for Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { estTokens, IMAGE_TOKENS, resolvePath, filesReadByCommand, oneLine, readRange } from './util.js';
import { newSession, jsonLines } from './claude.js';

function jsString(lit) {
  try { return JSON.parse(lit); } catch { return lit.slice(1, -1); }
}

// Pull the shell commands out of a code-mode `exec` script or tool arguments.
export function codexCommands(text) {
  const cmds = [];
  if (!text) return cmds;
  const re = /\b(?:cmd|command)"?\s*:\s*("(?:[^"\\]|\\.)*")/g;
  for (const m of text.matchAll(re)) cmds.push(jsString(m[1]));
  const arr = /"command"\s*:\s*(\[[^\]]*\])/.exec(text);
  if (arr) {
    try {
      const a = JSON.parse(arr[1]);
      if (Array.isArray(a)) cmds.push(a.length >= 3 && /sh$/.test(a[0]) ? a[a.length - 1] : a.join(' '));
    } catch {}
  }
  return cmds;
}

export function patchedFiles(text) {
  const out = [];
  if (!text) return out;
  const re = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g;
  for (const m of text.matchAll(re)) out.push(m[1].trim());
  return out;
}

function innerTools(text) {
  const seen = [];
  for (const m of (text || '').matchAll(/tools\.([A-Za-z0-9_]+)\(/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function outputText(output) {
  if (output == null) return { text: '', images: 0 };
  if (typeof output === 'string') return { text: output, images: 0 };
  if (Array.isArray(output)) {
    let text = '';
    let images = 0;
    for (const c of output) {
      if (!c) continue;
      if (typeof c.text === 'string') text += (text ? '\n' : '') + c.text;
      else if (c.type && /image/.test(c.type)) images++;
      else text += JSON.stringify(c);
    }
    return { text, images };
  }
  if (typeof output === 'object' && typeof output.content === 'string') return { text: output.content, images: 0 };
  return { text: JSON.stringify(output), images: 0 };
}

function exitCodes(text) {
  const codes = [];
  for (const m of text.matchAll(/"exit_code"\s*:\s*(-?\d+)/g)) codes.push(Number(m[1]));
  if (!codes.length) {
    const m = /(?:Exit code|Process exited with code)[: ]+(-?\d+)/i.exec(text);
    if (m) codes.push(Number(m[1]));
  }
  return codes;
}

export async function codexMeta(file) {
  // The first line holds session_meta, which can be large. Read the head only.
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n);
    const nl = head.indexOf('\n');
    const first = nl >= 0 ? head.slice(0, nl) : head;
    try {
      const o = JSON.parse(first);
      if (o.type === 'session_meta' && o.payload) return { id: o.payload.id || o.payload.session_id, cwd: o.payload.cwd };
    } catch {}
    const id = /"(?:session_)?id"\s*:\s*"([^"]+)"/.exec(first)?.[1];
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(first)?.[1];
    return { id, cwd: cwd ? jsString('"' + cwd + '"') : undefined };
  } finally {
    fs.closeSync(fd);
  }
}

export async function parseCodexSession(file) {
  const s = newSession('codex', file);
  const pending = new Map();
  let best = null;
  let estIn = 0;
  let estOut = 0;
  for await (const o of jsonLines(file)) {
    if (!o) { s.badLines++; continue; }
    const t = Date.parse(o.timestamp);
    if (!Number.isNaN(t)) {
      if (s.start == null || t < s.start) s.start = t;
      if (s.end == null || t > s.end) s.end = t;
    }
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;
    if (o.type === 'session_meta') {
      s.id = s.id || p.id || p.session_id;
      s.cwd = s.cwd || p.cwd;
      const model = p.base_instructions?.provenance?.model || p.model;
      if (model && !s.models.includes(model)) s.models.push(model);
      continue;
    }
    if (o.type === 'turn_context') {
      if (!s.cwd && p.cwd) s.cwd = p.cwd;
      if (p.model && !s.models.includes(p.model)) s.models.push(p.model);
      continue;
    }
    const total = (o.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage)
      || (o.type === 'token_usage_record' && p.thread_token_usage) || null;
    if (total) {
      if (!best || (total.total_tokens || 0) >= (best.total_tokens || 0)) best = total;
      continue;
    }
    if (o.type !== 'response_item') continue;

    if (p.type === 'message') {
      // Only used when the log has no usage records.
      const n = estTokens(outputText(p.content).text);
      if (p.role === 'assistant') estOut += n; else estIn += n;
      continue;
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const raw = p.type === 'custom_tool_call' ? p.input
        : p.type === 'local_shell_call' ? JSON.stringify(p.action || {})
        : p.arguments;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      const inner = innerTools(text);
      let tool = p.name || (p.type === 'local_shell_call' ? 'shell' : '?');
      if (tool === 'exec' && inner.length) tool = inner[0];
      const cmds = codexCommands(text);
      const patched = patchedFiles(text);
      let label = '';
      if (cmds.length) label = oneLine(cmds[0], 70) + (cmds.length > 1 ? ` (+${cmds.length - 1})` : '');
      else if (patched.length) label = patched[0] + (patched.length > 1 ? ` (+${patched.length - 1})` : '');
      else label = oneLine(text, 50);
      const call = {
        id: p.call_id || p.id,
        tool,
        label,
        cmd: cmds[0] ?? null,
        cmds,
        reads: [],
        writes: [],
        tokens: 0,
        isError: false,
        errorText: '',
        ts: t || null,
        sub: false,
        done: false,
      };
      for (const c of cmds) for (const f of filesReadByCommand(c)) {
        const r = resolvePath(f, s.cwd);
        if (r) call.reads.push(r);
      }
      if (call.reads.length && cmds.length === 1) call.range = readRange(cmds[0]);
      for (const f of patched) {
        const r = resolvePath(f, s.cwd);
        if (r) call.writes.push(r);
      }
      if (call.id) pending.set(call.id, call);
      s.calls.push(call);
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const call = pending.get(p.call_id);
      if (!call) continue;
      const { text, images } = outputText(p.output);
      call.tokens = estTokens(text) + images * IMAGE_TOKENS;
      estIn += call.tokens;
      call.done = true;
      const codes = exitCodes(text);
      call.exitCodes = codes;
      if (codes.some((c) => c !== 0)) {
        call.isError = true;
        call.errorText = text.slice(0, 2000);
      }
      pending.delete(p.call_id);
    }
  }
  if (best && ((best.input_tokens || 0) + (best.output_tokens || 0)) > 0) {
    const cached = best.cached_input_tokens || 0;
    s.usage.input = Math.max(0, (best.input_tokens || 0) - cached);
    s.usage.cacheRead = cached;
    s.usage.cacheWrite = best.cache_write_input_tokens || 0;
    s.usage.output = best.output_tokens || 0;
  } else {
    // No usage records (imported or very old logs). This counts each message
    // once, so it is a floor: real input re-sends the context every turn.
    s.usageEstimated = true;
    s.usage.input = estIn;
    s.usage.output = estOut;
  }
  if (!s.id) s.id = path.basename(file, '.jsonl').replace(/^rollout-[\dT:-]+?-(?=[0-9a-f]{8}-)/, '');
  return s;
}
