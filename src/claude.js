// Parser for Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { estTokens, IMAGE_TOKENS, resolvePath, filesReadByCommand, oneLine, readRange } from './util.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function newSession(agent, file) {
  return {
    agent,
    id: null,
    file,
    cwd: null,
    start: null,
    end: null,
    models: [],
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    usageEstimated: false,
    calls: [],
    subagents: 0,
    badLines: 0,
  };
}

export async function* jsonLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line[0] !== '{') { if (line.trim()) yield null; continue; }
    try { yield JSON.parse(line); } catch { yield null; }
  }
}

function resultText(content) {
  if (content == null) return { text: '', images: 0 };
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: 0 };
  let text = '';
  let images = 0;
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text') text += (text ? '\n' : '') + (c.text ?? '');
    else if (c.type === 'image') images++;
    else if (c.type === 'tool_reference') text += '';
    else text += JSON.stringify(c);
  }
  return { text, images };
}

export function claudeLabel(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash': return oneLine(i.command, 70);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return i.file_path || '';
    case 'NotebookEdit': return i.notebook_path || '';
    case 'Grep': return oneLine(`${i.pattern ?? ''}${i.path ? '  in ' + i.path : ''}`, 70);
    case 'Glob': return oneLine(i.pattern, 70);
    case 'WebFetch': try { return new URL(i.url).host; } catch { return oneLine(i.url, 50); }
    case 'WebSearch': return oneLine(i.query, 60);
    case 'Task': case 'Agent': return oneLine(i.description || i.subagent_type, 60);
    default: return '';
  }
}

export function toolDisplayName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name || '');
  if (m) return `mcp:${m[1]}/${m[2]}`;
  return name || '?';
}

async function parseClaudeFile(file, s, sub) {
  const seenMsg = new Set();
  const pending = new Map();
  for await (const o of jsonLines(file)) {
    if (!o) { s.badLines++; continue; }
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) {
        if (s.start == null || t < s.start) s.start = t;
        if (s.end == null || t > s.end) s.end = t;
      }
    }
    if (!s.cwd && typeof o.cwd === 'string') s.cwd = o.cwd;
    if (!sub && !s.id && typeof o.sessionId === 'string') s.id = o.sessionId;
    const msg = o.message;
    if (o.type === 'assistant' && msg && typeof msg === 'object') {
      const key = msg.id || o.requestId || o.uuid;
      if (msg.model && msg.model !== '<synthetic>' && !s.models.includes(msg.model)) s.models.push(msg.model);
      if (key && !seenMsg.has(key)) {
        seenMsg.add(key);
        const u = msg.usage;
        if (u && typeof u === 'object') {
          s.usage.input += u.input_tokens || 0;
          s.usage.cacheWrite += u.cache_creation_input_tokens || 0;
          s.usage.cacheRead += u.cache_read_input_tokens || 0;
          s.usage.output += u.output_tokens || 0;
        } else if (msg.model !== '<synthetic>') {
          s.usageEstimated = true;
          s.usage.output += estTokens(JSON.stringify(msg.content ?? ''));
        }
      }
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c && c.type === 'tool_use' && c.id) {
            const call = {
              id: c.id,
              tool: c.name,
              label: claudeLabel(c.name, c.input),
              cmd: c.name === 'Bash' ? c.input?.command ?? null : null,
              reads: [],
              writes: [],
              tokens: 0,
              isError: false,
              errorText: '',
              ts: Date.parse(o.timestamp) || null,
              sub: !!sub,
              ctx: sub || 'main',
              done: false,
            };
            const cwd = s.cwd;
            if (c.name === 'Read') {
              const p = resolvePath(c.input?.file_path, cwd);
              if (p) call.reads.push(p);
              call.range = `${c.input?.offset ?? ''}:${c.input?.limit ?? ''}:${c.input?.pages ?? ''}`;
            } else if (c.name === 'Bash') {
              for (const f of filesReadByCommand(call.cmd)) {
                const p = resolvePath(f, cwd);
                if (p) call.reads.push(p);
              }
              if (call.reads.length) call.range = readRange(call.cmd);
            } else if (EDIT_TOOLS.has(c.name)) {
              const p = resolvePath(c.input?.file_path || c.input?.notebook_path, cwd);
              if (p) call.writes.push(p);
            }
            pending.set(c.id, call);
            s.calls.push(call);
          }
        }
      }
    } else if (o.type === 'user' && msg && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (!c || c.type !== 'tool_result') continue;
        const call = pending.get(c.tool_use_id);
        if (!call) continue;
        const { text, images } = resultText(c.content);
        call.tokens = estTokens(text) + images * IMAGE_TOKENS;
        call.done = true;
        if (c.is_error) {
          // A user saying "no" to a tool is not a failure of the command.
          if (!/doesn't want to proceed|tool use was rejected|User rejected/i.test(text)) {
            call.isError = true;
            call.errorText = text.slice(0, 2000);
          }
        }
        pending.delete(c.tool_use_id);
      }
    }
  }
}

export async function parseClaudeSession(file, { subagents = true } = {}) {
  const s = newSession('claude', file);
  await parseClaudeFile(file, s, false);
  if (!s.id) s.id = path.basename(file, '.jsonl');
  if (subagents) {
    const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch {}
    for (const n of names) {
      s.subagents++;
      await parseClaudeFile(path.join(dir, n), s, n);
    }
  }
  return s;
}
