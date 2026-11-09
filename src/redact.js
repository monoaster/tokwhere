// --redact: hide project names, file names and command text so output can be shared.
import path from 'node:path';
import { normalizeCommand } from './util.js';

// Tools whose second word is a subcommand (npm test), not a user's file name.
const SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'swift', 'make', 'docker', 'gh', 'uv', 'pip', 'brew', 'xcodebuild']);

export function redact(r) {
  const projects = new Map();
  const files = new Map();
  const proj = (name) => {
    if (!projects.has(name)) projects.set(name, `project-${projects.size + 1}`);
    return projects.get(name);
  };
  const file = (p) => {
    if (!p) return p;
    if (!files.has(p)) {
      const ext = path.extname(p);
      files.set(p, `file-${files.size + 1}${ext.length <= 6 ? ext : ''}`);
    }
    return files.get(p);
  };
  // Keep the program name of a command, drop its arguments.
  const cmd = (c) => {
    if (!c) return c;
    let [first = '', second = ''] = normalizeCommand(c).split(/\s+/);
    if (first.includes('/')) {
      // venv/bin/python -> python, but never a custom script name.
      first = path.basename(first);
      if (!/^(python[\d.]*|node|ruby|bash|sh|zsh|pytest|swift|go|cargo|npm|npx)$/.test(first)) return '…';
    }
    const sub = SUBCOMMANDS.has(first) && /^[a-z][a-z-]{0,11}$/.test(second) ? ' ' + second : '';
    return `${first}${sub} …`;
  };
  const label = (tool, l) => {
    if (!l) return l;
    if (/^(Read|Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/.test(tool)) return file(l);
    if (/^(Bash|exec_command|shell)$/.test(tool)) return cmd(l);
    return '…';
  };

  return {
    ...r,
    sessions: r.sessions.map((s) => ({ ...s, project: proj(s.project), cwd: null })),
    projects: r.projects.map((p) => ({ ...p, project: proj(p.project) })),
    files: r.files.map((f) => ({ ...f, file: file(f.file), cwd: null })),
    biggest: r.biggest.map((b) => ({ ...b, project: proj(b.project), label: label(b.tool, b.label), cwd: null })),
    waste: r.waste.map((w) => ({
      ...w,
      ...(w.file ? { file: file(w.file), cwd: null } : {}),
      ...(w.cmd ? { cmd: cmd(w.cmd) } : {}),
      ...(w.label ? { label: label(w.tool, w.label), cwd: null } : {}),
    })),
  };
}
