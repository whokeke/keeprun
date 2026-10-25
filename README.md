# keeprun — opencode autonomous loop

Session-level auto-continue loop for [opencode](https://github.com/anomalyco/opencode) (verified on v1.17.13).

`/keeprun <task>` alternates a **read-only planning phase** (strong model) with a **build phase** (the original model), one concrete step at a time, until the task is done, blocked, or `--max` cycles are reached. `/keepstop` stops the loop and restores the session.

With `--for=8h` the loop becomes time-boxed instead: it keeps going for up to the given duration, and when the model reports the objective complete it enters a **challenger round** — an adversarial reviewer pass that digs up the next valuable task (edge cases, tests, error handling, performance, maintainability, docs) instead of stopping.

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
/keeprun 推进 spec 基准调优 --for=8h
/keepstop
```

| Option | Default | Notes |
|---|---|---|
| `--plan-model=provider/model` | `deepseek/GLM-5.3` (in `agents/keeprun-plan.md`) | or `KEEPRUN_PLAN_MODEL` |
| `--build-model=provider/model` | model active before `/keeprun` | overrides auto-capture |
| `--max=N` | 20 | or `KEEPRUN_MAX_CYCLES` |
| `--for=<duration>` | none | `30s` / `45m` / `8h` / `1d` / `1h30m`; or `KEEPRUN_FOR`. Lifts the cycle cap; `KEEPRUN_DONE` triggers a challenger round while time remains |

Time budget details: the remaining time is included in every plan/build prompt; when the budget is exhausted the loop stops with `time budget exhausted`; if the challenger returns `KEEPRUN_DONE` five consecutive times with no intervening build work, it stops with `challenger found no further work` to avoid burning tokens. `KEEPRUN_BLOCKED` always stops immediately (missing credentials or a genuine human decision cannot be resolved autonomously).

## How it works

1. The `/keeprun` command round returns `KEEPRUN_START` (cheap ack; captures the original model).
2. A read-only `keeprun-plan` agent (strong model) outputs the single next step that needs no user decision, ending in `KEEPRUN_PLAN_READY` / `KEEPRUN_DONE` / `KEEPRUN_BLOCKED: ...`.
3. The build agent executes and verifies that step with the original model.
4. Repeat until done / blocked / `--max` / time budget reached, then the session is restored. With `--for`, a `KEEPRUN_DONE` before the deadline starts a challenger round instead of stopping.

The session is hardened while running (`doom_loop: allow`, `question: deny`) so nothing blocks on interactive prompts.

Requirements: opencode with the built-in `build` agent and a configured provider for the planning model.

Design and internals: [`docs/keeprun-design.md`](docs/keeprun-design.md).
