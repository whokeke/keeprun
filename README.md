# keeprun — opencode autonomous loop

Session-level auto-continue loop for [opencode](https://github.com/anomalyco/opencode) (verified on v1.17.13).

`/keeprun <task>` alternates a **read-only planning phase** (strong model) with a **build phase** (the original model), one concrete step at a time, until the task is done, blocked, or `--max` cycles are reached. `/keepstop` stops the loop and restores the session.

With `--for=8h` the loop becomes time-boxed instead: it keeps going for up to the given duration, and when the model reports the objective complete it enters a **challenger round** — an adversarial reviewer pass that digs up the next valuable task (edge cases, tests, error handling, performance, maintainability, docs) instead of stopping.

With `--goal=...` (or `--goal=@goal.md`) every round is kept aligned to an **ultimate goal**. The goal document is read once at start and treated as an immutable snapshot for the whole run, so `/keeprun 推进调优 --for=8h --goal=@docs/goal.md` keeps aiming at the same target even across context handoffs.

When a session hits its context limit, keeprun compacts it, asks the planning model to write a **handoff document** (goal, completed work with evidence, in-flight state, next steps, conventions), and continues the same keeprun run in a **new session** with the same deadline, models and goal.

When the run stops (for any reason: done, time budget exhausted, blocked, `/keepstop`, max cycles, errors) keeprun asks the strong model to write a **summary document** — conclusion against the ultimate goal, completed work with evidence, key changes, follow-ups, pitfalls. With `--out=<dir>` every document of the run is collected in `<dir>/run-<timestamp>/` (`goal.md`, `handoff-<N>.md`, `summary.md`); without `--out` only `summary-<timestamp>.md` is written to the workspace root.

## Install

One-click (restart opencode afterwards):

```bash
curl -fsSL https://raw.githubusercontent.com/whokeke/keeprun/main/install.sh | bash
```

Or from a clone:

```bash
git clone https://github.com/whokeke/keeprun /tmp/keeprun && /tmp/keeprun/install.sh
```

Files are installed to `~/.config/opencode/{agents,plugins,command}/`. Existing files are backed up as `*.keeprun-bak.<timestamp>`. To remove:

```bash
curl -fsSL https://raw.githubusercontent.com/whokeke/keeprun/main/uninstall.sh | bash
```

## Usage

```text
/keeprun 修复 AArch64 LSO 的 ldp 配对回归
/keeprun 完成任务 --plan-model=gptplus/claude-opus-4-6-thinking-aws --max=10
/keeprun 推进 spec 基准调优 --for=8h --goal=@docs/spec-goal.md --out=docs/keeprun
/keeprun 修 LSO 回归 --goal="ldp 配对率达到上游水平"
/keepstop
```

| Option | Default | Notes |
|---|---|---|
| `--plan-model=provider/model` | `deepseek/GLM-5.3` (in `agents/keeprun-plan.md`) | or `KEEPRUN_PLAN_MODEL` |
| `--build-model=provider/model` | model active before `/keeprun` | overrides auto-capture |
| `--max=N` | 20 | or `KEEPRUN_MAX_CYCLES` |
| `--for=<duration>` | none | `30s` / `45m` / `8h` / `1d` / `1h30m`; or `KEEPRUN_FOR`. Lifts the cycle cap; `KEEPRUN_DONE` triggers a challenger round while time remains |
| `--goal="text"` / `--goal=@file.md` | the task text | or `KEEPRUN_GOAL`. `@` reads a goal document (relative to the worktree, capped at 16 KB); it is snapshotted at start and must not change during the run |
| `--out=<dir>` | workspace root (summary only) | or `KEEPRUN_OUT`. Collects all run documents in `<dir>/run-<timestamp>/`: `goal.md`, `handoff-<N>.md`, `summary.md`. `KEEPRUN_SUMMARY=off` disables the default summary |

Time budget details: the remaining time is included in every plan/build prompt; when the budget is exhausted the loop stops with `time budget exhausted`; if the challenger returns `KEEPRUN_DONE` five consecutive times with no intervening build work, it stops with `challenger found no further work` to avoid burning tokens. `KEEPRUN_BLOCKED` always stops immediately (missing credentials or a genuine human decision cannot be resolved autonomously).

Context handoff details: opencode's automatic compaction is honoured (a `ContextOverflowError` no longer stops the loop). For context errors the provider does not classify, keeprun compacts the session itself before writing the handoff. If the model-written handoff fails, the plugin builds a fallback document from the recent transcript. At most 5 handoffs are allowed per run (`too many context handoffs`). The new session is driven automatically; open it in the TUI to follow along (the old session shows a note with the new session id).

## How it works

1. The `/keeprun` command round returns `KEEPRUN_START` (cheap ack; captures the original model).
2. A read-only `keeprun-plan` agent (strong model) outputs the single next step that needs no user decision, ending in `KEEPRUN_PLAN_READY` / `KEEPRUN_DONE` / `KEEPRUN_BLOCKED: ...`.
3. The build agent executes and verifies that step with the original model.
4. Repeat until done / blocked / `--max` / time budget reached, then the session is restored. With `--for`, a `KEEPRUN_DONE` before the deadline starts a challenger round instead of stopping. On context overflow the run compacts, writes a handoff document and continues in a new session.

The session is hardened while running (`doom_loop: allow`, `question: deny`) so nothing blocks on interactive prompts.

Requirements: opencode with the built-in `build` agent and a configured provider for the planning model.

Design and internals: [`docs/keeprun-design.md`](docs/keeprun-design.md).
