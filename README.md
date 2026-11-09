# tokwhere

See where your coding agent's tokens went.

`tokwhere` reads the session logs that Claude Code and Codex already keep on your
machine. It tells you how many tokens a session used, which tools filled the
context, which files were read again and again, and which commands kept failing.

## Demo

A real 24-hour Claude Code session, run with `--redact` so project and file names are hidden.
The numbers are as printed.

```
$ tokwhere --session 46110c20 --redact
tokwhere  claude · project-1 · 46110c20
          Nov 6, 00:12 → Nov 6, 23:48 (23h35m) · claude-opus-5-5 +1 · 1300 tool calls · 17 subagents

TOKENS  (from the logs' usage fields)
  input              2,289
  cache write    3,981,908
  cache read   196,059,070
  output         1,132,796
  total        201,176,063

TOOL RESULTS  ~763k tokens put into context (estimated)
  tool                            calls  failed  tokens
  Bash                              849      72   ~576k
  Read                               58           ~129k
  mcp:computer-use/app_batch          8            ~15k
  WebSearch                          16            ~12k
  mcp:computer-use/app_screensh…      5           ~9.6k
  Edit                              135       2   ~5.9k
  Write                             107           ~5.8k
  Agent                              17           ~4.6k
  mcp:ccd_turn/wrap_up               29           ~1.3k
  Monitor                             2       2    ~790

FILES READ MOST
  reads  unchanged  tokens  file
    23×          8    ~22k  file-1.swift
    19×          8    ~12k  file-2.py
    17×          3    ~11k  file-3.py
    16×          2    ~12k  file-4.py
    10×          3    ~20k  file-5.py
    10×          2   ~5.4k  file-6.py
     9×          1    ~19k  file-7.md
     9×          1   ~5.1k  file-8.md

BIGGEST SINGLE RESULTS
   ~10k  Read  file-9.swift
  ~8.9k  Read  file-10.py
  ~8.8k  Read  file-11.txt
  ~8.4k  Read  file-12.txt
  ~8.2k  Read  file-13.py
  ~7.5k  Bash  cat …
  ~7.4k  Bash  cat …
  ~7.4k  Bash  cat …

WASTE
   ~6.4k  file-1.swift re-read 8× unchanged
   ~4.3k  file-2.py re-read 8× unchanged
   ~3.2k  file-14.png re-read 2× unchanged
    ~22k  file-1.swift read 23× by 5 subagents
    ~20k  file-5.py read 10× by 5 subagents
    ~232  `git branch …` failed 2×

~ = estimate (characters / 4). Token totals come from the logged usage fields.
```

The last week, all projects (trimmed):

```
$ tokwhere --days 7 --redact
tokwhere  last 7 days · 181 sessions (82 claude, 99 codex) · 62 projects

TOKENS  (from usage fields; some sessions estimated)
  input            2,028,149
  cache write     49,177,834
  cache read   4,038,134,636
  output          15,809,345
  total        4,105,149,964

...
WASTE
    ~29k  file-13.png re-read 18× unchanged
    ~29k  file-14.png re-read 18× unchanged
    ~13k  file-5.md re-read 16× unchanged
   ~124k  file-15.md read 15× by 14 subagents
    ~91k  file-9.md read 7× by 5 subagents
    ~492  `node …` failed 12×
   ~1.1k  `python …` failed 4×
    ~456  `uv run …` failed 3×
   ~694k  58 tool results over 10k tokens each

~ = estimate (characters / 4). Token totals come from the logged usage fields.
```

What this told me: one file was loaded by 14 different subagents (~124k tokens),
two screenshots were re-read 18 times each without changing, and 58 single tool
results were over 10k tokens.

## Install

Needs Node.js 20 or newer. No dependencies.

```bash
npx github:monoaster/tokwhere
```

Or clone it and link it:

```bash
git clone https://github.com/monoaster/tokwhere
cd tokwhere && npm link
tokwhere --help
```

## Usage

```bash
tokwhere                      # latest session for the current folder
tokwhere --days 7             # every session in the last 7 days, all projects
tokwhere --days 7 --project . # last 7 days, this folder only
tokwhere --session 46110c20   # one session by id or id prefix
tokwhere --agent codex        # only Codex sessions
tokwhere --json               # full report as JSON
tokwhere --redact             # hide project, file and command names
```

Other options: `--top <n>` rows per section (default 8), `--huge <tokens>` the size
that counts as a huge result (default 10000), `--full-paths`, `--no-subagents`.

`--project` takes a path, `.` or a folder name (`--project my-app`).

## Agent setup

There is a skill in `skill/tokwhere/SKILL.md`. Copy it to Claude Code:

```bash
mkdir -p ~/.claude/skills && cp -r skill/tokwhere ~/.claude/skills/
```

Or add this to `CLAUDE.md` / `AGENTS.md`:

```markdown
## Token use
When I ask where tokens went or why a session is expensive, run
`npx github:monoaster/tokwhere` (add `--days 7` for the week). Report the top
items under WASTE in plain words and suggest one change for each.
Use `--redact` if the output will be shared.
```

## How it works

- Claude Code writes one JSONL file per session under `~/.claude/projects/<folder>/`.
  Subagent logs sit next to it in `<session>/subagents/`. Codex writes rollouts under
  `~/.codex/sessions/YYYY/MM/DD/`.
- Token totals come from the `usage` fields in those logs. Claude Code repeats the
  same usage on every block of one API message, so tokwhere counts each message id once.
  Codex logs running totals, so tokwhere takes the last one.
- Tool result sizes are estimates: characters divided by 4, plus a flat 1,600 per image.
  They are marked with `~`.
- A re-read counts as "unchanged" when the same file and range was read before in the
  same agent context, and no Edit, Write or patch touched the file since. Reads by
  different subagents are reported separately, because each one starts with an empty context.
- File reads include the Read tool and simple shell reads (`cat`, `head`, `tail`, `sed -n`, `nl`).
- Failing commands are grouped after removing noise like `cd dir &&`, `FOO=1`, `timeout 60`,
  `2>&1` and a trailing `| tail`.
- Lines it does not understand are skipped. Nothing leaves your machine.

## Limits

- All `~` numbers are estimates. Real tokenizers differ, often by 10-30% from characters / 4.
- A tool result's size is counted once, when it enters the context. In practice it is
  re-sent (mostly as cheap cache reads) on every later turn until a compaction. tokwhere
  does not try to model that.
- The log formats are not documented and change between versions. tokwhere was built
  against Claude Code 2.1 and Codex CLI 0.159 logs. If a newer version changes them,
  some sections may come out empty.
- Shell file-read detection is a heuristic. `rg`, `grep` and scripts that read files are not counted as reads.
- Codex sessions imported from elsewhere may have no usage data; those totals are a rough floor and marked `~`.
- Only Claude Code and Codex for now. Cursor and OpenCode keep their history in other formats.

## License

MIT
