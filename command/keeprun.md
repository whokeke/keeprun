---
description: Start the keeprun autonomous loop — plan the next step with a strong model, then implement it with build + the original model, repeating until done (no cycle cap by default). Usage: /keeprun <task> [--plan-model=provider/model] [--build-model=provider/model] [--max=N] [--for=8h] [--goal="text"|--goal=@goal.md] [--out=docs-dir] [--watchdog=2h] [--aggressive]
agent: build
---

KEEPRUN is starting. Do not implement anything yet and do not use tools.
Reply with exactly: KEEPRUN_START

Task: $ARGUMENTS
