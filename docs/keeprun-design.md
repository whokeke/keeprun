# opencode `/keeprun` 设计与人机协同循环实现

> 版本：opencode 1.17.13（anomalyco/opencode，tag `v1.17.13`）
> 位置：`~/.config/opencode/`
> 目标：让一个长任务在**无人值守**情况下持续运行，并用“强模型规划 → 原模型实施”的双阶段循环避免模型提前停工。

---

## 1. 背景与目标

opencode 原生在每一轮 assistant 回复结束后进入 `idle`，等待用户下一条消息。长任务常因模型“阶段性总结/等待确认”而中断。目标：

1. `/keeprun <task>` 开启一个**会话级**自动续跑循环。
2. 每次续跑不是简单说“继续”，而是：
   - 切换到**更强的规划模型 + 只读 plan 模式**；
   - 产出**唯一一个无需用户决策的下一步计划**；
   - 再切回 **build 模式 + 原模型**执行并验证；
   - 循环直到完成/阻塞/触顶/手动停止。
3. 全程尽量不被权限询问、提问工具、plan 退出确认打断。
4. 提供 `/keepstop` 手动停止，并恢复原 agent/model。

---

## 2. 需求与关键决策

| 决策点 | 选择 |
|---|---|
| 核心行为 | 自动续跑（每轮结束后自动注入下一步） |
| 触发方式 | `/keeprun` + `/keepstop`（会话级，不做关键字/全局常开） |
| 停止条件 | 完成标记 + 最大轮数（默认 20） |
| 规划模型 | 默认 `deepseek/GLM-5.3`，可通过参数/环境变量/agent 文件修改 |
| 实施阶段 | 内置 `build` agent + `/keeprun` 前的**原模型** |
| 零打断加固 | `doom_loop: allow` + `question: deny`（keeprun 会话级） |

---

## 3. 上游机制核查（实现依据）

以下结论均对照 opencode `v1.17.13` 源码确认，是方案能成立的前提。

### 3.1 命令钩子

`packages/opencode/src/session/prompt.ts` 的 `SessionPrompt.command()`：

```ts
yield* plugin.trigger(
  "command.execute.before",
  { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
  { parts },
)
const result = yield* prompt({ ..., parts })
```

结论：

- 钩子在用户消息创建、run 启动**之前**触发，适合做状态初始化。
- `command` 是**不带斜杠**的命令名（`keeprun`/`keepstop`）。
- `output.parts` 与调用方的 `parts` 是**同一个数组引用**；插件必须**原地修改**（`length=0` + `push`），替换数组引用不会生效。
- `plugin.trigger` 会 `await` 每个 hook，因此插件内可安全做异步 HTTP 调用。

### 3.2 命令自身的 agent/model 解析

```ts
const agentName = cmd.agent ?? input.agent
const taskModel =
  cmd.model ? parse(cmd.model)
  : cmd.agent && cmdAgent?.model ? cmdAgent.model
  : input.model ? parse(input.model)
  : currentModel(sessionID)
```

- 命令 frontmatter 的 `agent:` 决定该轮 agent。
- 不给命令设置 `agent:`，则沿用会话当前 agent/model（TUI 手动切换的模型能被保留）。

### 3.3 `promptAsync` 与 busy

`server/routes/.../handlers/session.ts` 的 `promptAsync` 把 `promptSvc.prompt(...)` `fork` 到后台并立即返回 `204`；失败被捕获后发布 `session.error`。

`effect/runner.ts` 的 `ensureRunning` 在已有 run 时执行 `awaitDone(st.run.done)`，**新消息不会丢**：进行中的 `runLoop` 每轮重新读取消息，循环条件 `lastUser.id < lastAssistant.id` 会让它吸收新 user 消息。

结论：只在 `idle` 后注入即可；无需为 busy 做重试。

### 3.4 `session.idle` 时机

`session/status.ts`：状态置为 `idle` 时发布 `session.idle`。`run-state.ts` 的 Runner `onIdle` 在**整个 run 结束**（含所有工具调用、compaction）后触发一次。

- 一个 run 内多次工具调用**只有一次** idle。
- **用户按 Esc / abort 也会触发 idle**，且最后一条 assistant 消息带 `MessageAbortedError`。
- compaction 在 run 内部完成，不会产生额外 idle，因此不存在“自动续跑与 compaction autocontinue 双发”的竞态。

### 3.5 按消息切换 agent/model

`PromptPayload` 支持 `agent` 与 `model: { providerID, modelID }`；`createUserMessage` 会调用 `setAgentModel` 更新会话当前 agent/model。

结论：每次注入 plan/build 消息时显式传 `agent` + `model`，即可实现可见的“模式切换/切回”。

### 3.6 权限合并顺序

`permission/index.ts`：`merge = flat()`，`evaluate = rulesets.flat().findLast(...)`，**最后匹配者胜**。

- 工具执行时使用 `merge(agent.permission, session.permission)`，session 在后。
- 生成工具列表时 `session/llm/request.ts:209` 同样使用 `merge(agent.permission, input.permission)` 计算 `disabled`。

结论：**会话级** `session.permission` 可以覆盖 agent 权限，从而仅对 keeprun 会话禁用 `question`、放行 `doom_loop`，不影响其他会话。

### 3.7 内置 plan 模式为何不能直接用

- `tool/plan.ts` 的 `plan_exit` 会调用 `question.ask(...)` **阻塞等待用户点确认**。
- `session/reminders.ts` 在进入 `plan` agent 时注入 `PLAN_MODE` 工作流，明确要求“提问/调用 plan_exit，否则不要结束回合”。
- 这些都会让无人值守卡死。

结论：使用**自定义只读 agent** `keeprun-plan`，保留 plan 语义（只读、只规划），去掉交互式退出/提问。

### 3.8 自定义 agent 的提示与权限

- `session/llm/request.ts`：`input.agent.prompt` 存在时**替换**默认 provider 系统提示（环境信息、AGENTS.md 指令仍会追加）。
- `agent/agent.ts`：配置文件里的 agent `permission` 在合并顺序中**最后**追加，因此可覆盖全局 `edit: allow`。

结论：自定义 agent 的只读权限可以真正生效。

### 3.9 消息分页

`MessageV2.page` 按 `time_created desc, id desc` 取 `limit+1` 条后 `reverse()`。

结论：`GET /session/{id}/message?limit=N` 返回**最近 N 条**（页内按时间升序），可直接取最后一条 assistant。

---

## 4. 总体架构

```
~/.config/opencode/
├── agents/keeprun-plan.md        # 只读规划 agent（强模型）
├── plugins/keeprun.ts            # 状态机 + 模型/agent 切换 + 加固/恢复
├── command/keeprun.md            # /keeprun 入口
└── command/keepstop.md           # /keepstop 入口
```

不需要修改 `opencode.json`；插件与命令均在启动时自动发现（重启生效）。

### 4.1 文件职责

| 文件 | 职责 |
|---|---|
| `agents/keeprun-plan.md` | 规划阶段系统提示；只读权限；默认模型 `deepseek/GLM-5.3`；`steps: 20` |
| `plugins/keeprun.ts` | 监听命令与事件；维护会话状态；注入 plan/build 消息；完成判定；停止恢复；看门狗 |
| `command/keeprun.md` | 注册 `/keeprun`；fallback 模板（插件会覆盖 parts） |
| `command/keepstop.md` | 注册 `/keepstop`；让模型确认 |

---

## 5. 状态机与时序

### 5.1 状态

```ts
type Phase = "ack" | "plan" | "build"

type St = {
  active: boolean
  phase: Phase
  planModel?: ModelRef      // 未指定时交由 agent frontmatter 决定
  buildModel?: ModelRef     // /keeprun 前的原模型
  task: string
  cycles: number
  maxCycles: number
  lastAssistantID?: string  // 去重
  capturePending: boolean    // 等待捕获原模型
  restore: boolean           // /keepstop 后待恢复
  processing: boolean        // 防并发 idle 重入
  watchdog?: Timeout
}
```

### 5.2 完整时序

```
用户：/keeprun <task> [--plan-model=...] [--build-model=...] [--max=N]
  │
  ├─ command.execute.before
  │    ├─ 解析参数、剥离 flag
  │    ├─ 会话级加固：session.permission += {doom_loop:allow, question:deny}
  │    ├─ 状态 phase = "ack"
  │    └─ 覆盖命令 parts 为“确认 + 任务”
  │
  ├─ ack 轮（build + 原模型，仅回 KEEPRUN_START）
  │    └─ chat.message 捕获原模型
  │
  ├─ idle(ack)
  │    └─ 注入 plan 轮：agent=keeprun-plan, model=规划模型
  │
  ├─ plan 轮（只读，产出唯一下一步）
  │    └─ 结尾标记：KEEPRUN_PLAN_READY / KEEPRUN_DONE / KEEPRUN_BLOCKED
  │
  ├─ idle(plan)
  │    ├─ DONE     → 停止
  │    ├─ BLOCKED  → 停止并提示
  │    └─ 其他     → 注入 build 轮：agent=build, model=原模型
  │
  ├─ build 轮（实施 + 验证）
  │    └─ 结尾标记：KEEPRUN_DONE / KEEPRUN_CONTINUE
  │
  └─ idle(build)
       ├─ DONE          → 停止
       ├─ cycles++ ≥ max → 停止（触顶）
       └─ 否则          → 回到 plan 轮
```

### 5.3 为什么有 ack 轮

`/keeprun` 自身也走一次命令 run。为了让**第一轮就由强模型规划**，同时**精确捕获原模型**：

- 命令 frontmatter 固定 `agent: build`，模板只让模型回 `KEEPRUN_START`（一次很便宜的调用）；
- 通过 `chat.message` 读取该轮实际使用的 `message.model`，作为后续 build 轮的原模型。

这样即使新会话里用户在 TUI 手动切过模型，也能被准确继承。

---

## 6. 插件实现

### 6.1 钩子

| 钩子 | 作用 |
|---|---|
| `command.execute.before` | 识别 `keeprun`/`keepstop`；解析参数；加固；覆盖 parts |
| `chat.message` | 捕获 `/keeprun` 命令轮的实际 agent/model |
| `event` | 处理 `session.idle`（推进状态机）、`session.error`（停止）、`session.deleted`（清理） |

### 6.2 关键函数

| 函数 | 说明 |
|---|---|
| `parseArgs` | 解析 `--plan-model=`、`--build-model=`、`--max=`，并从任务文本中剥离 |
| `parseModel` | `provider/model` → `{providerID, modelID}` |
| `setPermissions` | 调 `client.session.update({body:{permission:[...]}})`；SDK 类型偏旧，使用 `as any` |
| `loadMessages` / `lastAssistant` / `lastUserModel` | 读取最近消息、最后 assistant、最后 user 的模型 |
| `sendPlan` | 设置 `phase=plan`，注入规划消息 |
| `sendBuild` | 设置 `phase=build`，注入实施消息 |
| `dispatch` | 调 `promptAsync`，设置看门狗，处理失败 |
| `stop` | 停用状态、去加固、必要时恢复原 agent/model |
| `restoreSession` | 用 `noReply` 消息把会话切回 `build + 原模型` |
| `onIdle` | 状态机核心：去重、错误判定、标记判定、阶段推进 |
| `markerOf` | 只在最后 6 个非空行里识别标记，避免正文误判 |

### 6.3 标记协议

| 标记 | 产生方 | 含义 |
|---|---|---|
| `KEEPRUN_START` | ack 轮 | 确认进入循环 |
| `KEEPRUN_PLAN_READY` | plan 轮 | 已给出可执行的下一步 |
| `KEEPRUN_DONE` | plan/build 轮 | 整个任务完成并验证 |
| `KEEPRUN_BLOCKED: <question>` | plan 轮 | 确需用户决策，停止 |
| `KEEPRUN_CONTINUE` | build 轮 | 本步完成但任务未结束（插件即使没看到也默认继续） |

判定规则（`markerOf`）：

- 只看最后 6 个非空行；
- 去掉行首装饰（`> * # \`` `_` `-`）、行尾装饰、句末标点；
- `DONE`/`READY`/`START` 要求整行精确匹配；
- `BLOCKED` 允许 `KEEPRUN_BLOCKED: ...` 前缀。

### 6.4 错误与停止策略

在 `idle` 时读取最后一条 assistant 的 `info.error`：

| 错误 | 处理 |
|---|---|
| `MessageAbortedError`（用户 Esc） | 停止 |
| `ProviderAuthError` | 停止 |
| `MessageOutputLengthError` | plan 轮：停止（规划被截断）；build 轮：继续 |
| 其他（API/Unknown/ContentFilter 等） | 停止 |

另外：

- `session.error` 事件：若该会话处于 active，立即停止（涵盖注入失败、模型不存在等）。
- `session.deleted`：清理状态与看门狗。
- 看门狗：每次 `dispatch` 设 30 分钟定时器；若期间无 idle/error，则停止并提示。
- 最大轮数：每次 build 完成 `cycles++`；`cycles >= maxCycles` 停止。
- 手动 `/keepstop`：置 `active=false, restore=true`，在随后的 idle 恢复。

### 6.5 会话级“零打断”加固

开始：

```ts
session.permission += [
  { permission: "doom_loop", pattern: "*", action: "allow" },
  { permission: "question",  pattern: "*", action: "deny"  },
]
```

停止时追加相反的规则恢复：

```ts
session.permission += [
  { permission: "doom_loop", pattern: "*", action: "ask"   },
  { permission: "question",  pattern: "*", action: "allow" },
]
```

因为 `findLast` 语义，后追加的规则生效；且只影响当前会话。

效果：

- 连续 3 次相同工具调用不会弹 `doom_loop` 询问；
- 规划/实施阶段无法调用 `question` 工具，不会阻塞等待用户。

### 6.6 停止后的恢复

`stop()` 会：

1. 从状态表删除，防止重入；
2. 清除看门狗；
3. toast 提示；
4. 判断当前会话是否已经处于 `build + 原模型`（`needsRestore`）：
   - 不是 → 用 `noReply: true` 注入一条 synthetic 消息，切回 `build + 原模型`；
   - 是 → 只恢复权限。

`noReply` 只创建消息、不触发新的 run，因此不会引发递归 idle。

---

## 7. 规划 Agent 设计

`agents/keeprun-plan.md`：

```yaml
---
description: Read-only planning phase for the keeprun autonomous loop...
mode: primary
model: deepseek/GLM-5.3
steps: 20
permission:
  edit: deny
  write: deny
  apply_patch: deny
  question: deny
  task: deny
  todowrite: deny
---
```

要点：

- `mode: primary`：可被 `promptAsync` 的 `agent` 直接选中，也会出现在 agent 列表。
- `model`：默认规划模型；不传 `--plan-model` 时由它决定（插件不强行覆盖，便于只改这一处）。
- 权限：`disabled()` 会把 `edit/write/apply_patch` 映射到 `edit` 权限，`edit: deny` 即可禁用全部写工具；`question`/`task` 被禁用。
- 系统提示（文件正文）会被用作 `agent.prompt`，替换默认 provider 提示；环境信息与 AGENTS.md 仍会追加。
- 提示要求：只读、不提问、不派生子代理、输出唯一“无需决策的下一步”、结尾必须带标记。

---

## 8. 命令设计

### `/keeprun`

```yaml
---
description: Start the keeprun autonomous loop — plan the next step with a strong model, then implement it with build + the original model, repeating until done. Usage: /keeprun <task> [--plan-model=provider/model] [--build-model=provider/model] [--max=N]
agent: build
---
KEEPRUN is starting. Do not implement anything yet and do not use tools.
Reply with exactly: KEEPRUN_START

Task: $ARGUMENTS
```

插件会在 `command.execute.before` 中用“剥离 flag 后的任务 + 确认指令”覆盖 parts，因此 transcript 里仍能看到任务，但参数不会污染上下文。

### `/keepstop`

```yaml
---
description: Stop the keeprun autonomous loop and restore the session to build + the original model.
agent: build
---
KEEPRUN is being stopped. Confirm in one short sentence and do not start new work.
```

---

## 9. 可配置项

| 配置 | 默认 | 方式 |
|---|---|---|
| 规划模型 | `deepseek/GLM-5.3` | 改 `agents/keeprun-plan.md` 的 `model`；或 `/keeprun --plan-model=provider/model`；或环境变量 `KEEPRUN_PLAN_MODEL` |
| 实施模型 | `/keeprun` 前的原模型 | `/keeprun --build-model=provider/model` 覆盖 |
| 最大循环 | 20 | `/keeprun --max=N`；或环境变量 `KEEPRUN_MAX_CYCLES` |
| 看门狗 | 30 分钟 | 代码常量 `WATCHDOG_MS` |

优先级：命令行参数 > 环境变量 > agent frontmatter。

---

## 10. 边界与已知限制

1. **自定义只读 agent，不是内置 `plan`**：不显示内置 plan 的 plan-file/UI 横幅。这是为了避开 `plan_exit`/`question` 的阻塞。
2. **bash 无法真正只读**：与内置 plan 一致，靠系统提示约束；规划 agent 仍可执行读命令。
3. **子代理会话不在加固范围**：`session.permission` 只作用于主会话；`explore/general` 等子代理会话若出现连续相同调用，仍可能触发 `doom_loop` 询问。彻底杜绝需在 `opencode.json` 顶层加：
   ```json
   "permission": { "doom_loop": "allow", "question": "deny" }
   ```
   （会全局生效，影响手工会话。）
4. **模型必须存在**：规划模型不可用会通过 `session.error` 停止并提示，不会挂起。
5. **标记依赖模型配合**：若 build 未输出 `KEEPRUN_DONE`，规划轮仍有机会根据实际状态判定完成；否则会继续 Loop 到 `--max`。
6. **用户手动插话**：循环期间用户消息会被当前 run 吸收；下一轮仍会切回 keeprun 的 agent/model。需要退出请 `/keepstop`。
7. **状态仅存内存**：重启 opencode 后需重新 `/keeprun`。
8. **需重启生效**：插件/命令在启动时加载，当前正在运行的会话不会热加载。

---

## 11. 验证记录

### 11.1 配置加载验证

```bash
opencode debug agent keeprun-plan
opencode debug config
```

确认：

- `keeprun-plan` 存在，`mode: primary`，`model: deepseek/GLM-5.3`，`steps: 20`；
- 权限列表中 `edit: allow`（全局）在前、`edit: deny`（agent）在后，按 `findLast` 生效；
- `keeprun` / `keepstop` 命令注册成功；
- 插件 spec 被识别：`file:///home/hukeke/.config/opencode/plugins/keeprun.ts`。

### 11.2 状态机测试（内存 fake client）

用 Node 24 的 TypeScript 类型擦除直接 import `keeprun.ts`，构造假 `client.session`/`tui`，覆盖：

- ack parts 覆盖、flag 剥离、任务可见；
- 加固权限写入；
- ack → plan（agent/model 正确）；
- plan → build（切回原模型）；
- build 未完成 → 再次 plan；`--max` 触顶停止；
- `KEEPRUN_DONE` 停止且不再注入；
- `KEEPRUN_BLOCKED` 停止并恢复；
- `MessageAbortedError` 停止；
- `/keepstop` 在 idle 后恢复 `build`；
- 未显式指定规划模型时**不传 model**（交由 agent 决定）；
- 显式 `--plan-model` 时正确传参。

全部通过。

---

## 12. 使用说明

1. **重启 opencode**（重要）。
2. 在目标会话中执行：

   ```text
   /keeprun 修复 AArch64 LSO 的 ldp 配对回归
   /keeprun 完成任务 --plan-model=gptplus/claude-opus-4-6-thinking-aws --max=10
   ```

3. 观察会话自动切换：
   - `keeprun-plan`（规划模型）→ 下一步计划；
   - `build`（原模型）→ 实施 + 验证；
   - 重复直到 `KEEPRUN_DONE` / `KEEPRUN_BLOCKED` / 触顶。
4. 随时 `/keepstop` 停止并恢复。

---

## 13. 维护与扩展建议

- **换规划模型**：只改 `agents/keeprun-plan.md` 的 `model`，无需动插件。
- **调整循环节奏**：可在插件中把“每轮都先 plan”改成“每 N 轮 plan 一次”，只需在 `onIdle` 的 build 分支加计数判断。
- **让规划器写计划文件**：给 `keeprun-plan` 增加对 `.opencode/plans/*.md` 的 `edit` 允许，并在提示中要求写入；构建轮可从文件读取。
- **更严格的完成确认**：build 输出 `KEEPRUN_DONE` 后，不立即停止，而是追加一个“验证完成”的 plan 轮，由强模型二次确认。
- **全量子代理加固**：若需要完全无人值守，建议在 `opencode.json` 顶层放行 `doom_loop`、禁用 `question`。
- **日志排障**：opencode 日志中搜索 `[keeprun]`（toast 标题）与 `command.execute.before` / `session.idle` 事件；插件内部异常被捕获，不会中断会话。

---

## 附录 A：交付文件清单

| 路径 | 类型 | 说明 |
|---|---|---|
| `~/.config/opencode/agents/keeprun-plan.md` | agent | 只读规划 agent（约 1.7 KB） |
| `~/.config/opencode/plugins/keeprun.ts` | plugin | 状态机与调度（约 14 KB） |
| `~/.config/opencode/command/keeprun.md` | command | `/keeprun` |
| `~/.config/opencode/command/keepstop.md` | command | `/keepstop` |
| `/home/hukeke/doc/tool/keeprun-design.md` | doc | 本文档 |

> 源码以以上实际文件为准；本文档描述其设计契约与行为。

## 附录 B：常用校验命令

```bash
# 确认 agent 加载与模型/权限
opencode debug agent keeprun-plan

# 确认命令与插件被发现
opencode debug config | grep -iE "keeprun|keeprun-plan"

# 语法/加载检查（Node 24 类型擦除）
node -e 'import("file:///home/hukeke/.config/opencode/plugins/keeprun.ts").then(()=>console.log("PARSE_OK"))'
```

## 附录 C：排障速查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `/keeprun` 没有出现在命令列表 | 未重启 opencode | 退出并重启 |
| 启动后仍只回复不续跑 | 插件未加载（路径/语法） | 用附录 B 的命令检查；看日志 |
| 一直停在 plan 轮 | 模型持续输出 PLAN_READY 但 build 未触发 | 检查 `session.idle` 是否到达；看插件 toast |
| 规划模型报错 | 模型 ID 不在 provider 配置 | 改 `agents/keeprun-plan.md` 或传 `--plan-model` |
| 会话停在 `keeprun-plan` | 停止时恢复失败 | `/keepstop` 一次，或手动切回 build |
| 子代理弹权限询问 | 子代理会话未被会话级加固覆盖 | 需要时在 `opencode.json` 顶层放行 `doom_loop`/禁用 `question` |
| 触顶停止 | `--max`/`KEEPRUN_MAX_CYCLES` 太小 | 调大后重新 `/keeprun` |
