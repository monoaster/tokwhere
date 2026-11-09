---
name: tokwhere
description: Show where this coding session's tokens went (tool results, files read over and over, huge outputs, commands that kept failing). Use when the user asks why a session was expensive or slow, when context feels bloated, before /compact, or when they ask how to cut token use.
---

# tokwhere

`tokwhere` reads the local Claude Code and Codex session logs and reports where the
tokens went. It does not send anything anywhere.

## When to run it

- The user asks "where did my tokens go", "why is this so expensive", or "what is filling my context".
- Before suggesting a /compact or a fresh session, to see what is taking the space.
- After a long session, to find habits worth changing (re-reading the same file, giant test output).

## How to run it

```bash
npx github:monoaster/tokwhere            # latest session in the current folder
npx github:monoaster/tokwhere --days 7   # last 7 days, all projects
npx github:monoaster/tokwhere --json     # machine-readable
```

Add `--redact` before pasting the output anywhere public. It hides project names,
file names and command arguments.

## Reading the output

- TOKENS come from the usage fields in the logs. Cache reads are usually the biggest number; that is normal.
- Numbers with `~` are estimates (characters / 4). They show the size of each tool result when it entered context.
- WASTE lists the things you can act on:
  - "re-read N× unchanged": the same file was read again with no edit in between. Keep notes of what you need instead of reading it again.
  - "read N× by K subagents": each subagent loaded the same file into its own context. Pass the relevant part in the subagent prompt.
  - "`cmd` failed N×": the same command kept failing. Stop and change approach.
  - "tool results over 10k tokens": pipe big output through `tail`, `grep` or a summary.

Tell the user the top two or three items in plain words and suggest one concrete change for each.
