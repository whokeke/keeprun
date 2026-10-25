# keeprun — opencode autonomous loop

Session-level auto-continue loop for [opencode](https://github.com/anomalyco/opencode) (verified on v1.17.13).

`/keeprun <task>` alternates a **read-only planning phase** (strong model) with a **build phase** (the original model), one concrete step at a time, until the task is done, blocked, or `--max` cycles are reached. `/keepstop` stops the loop and restores the session.

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
/keepstop
```

| Option | Default | Notes |
|---|---|---|
| `--plan-model=provider/model` | `deepseek/GLM-5.3` (in `agents/keeprun-plan.md`) | or `KEEPRUN_PLAN_MODEL` |
| `--build-model=provider/model` | model active before `/keeprun` | overrides auto-capture |
| `--max=N` | 20 | or `KEEPRUN_MAX_CYCLES` |

## How it works

1. The `/keeprun` command round returns `KEEPRUN_START` (cheap ack; captures the original model).
2. A read-only `keeprun-plan` agent (strong model) outputs the single next step that needs no user decision, ending in `KEEPRUN_PLAN_READY` / `KEEPRUN_DONE` / `KEEPRUN_BLOCKED: ...`.
3. The build agent executes and verifies that step with the original model.
4. Repeat until done / blocked / `--max` reached, then the session is restored.

The session is hardened while running (`doom_loop: allow`, `question: deny`) so nothing blocks on interactive prompts.

Requirements: opencode with the built-in `build` agent and a configured provider for the planning model.

Design and internals: [`docs/keeprun-design.md`](docs/keeprun-design.md).
