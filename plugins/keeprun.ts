import { readFile, stat } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

type ModelRef = { providerID: string; modelID: string }

type Phase = "ack" | "plan" | "build" | "handoff"

type St = {
  active: boolean
  phase: Phase
  planModel?: ModelRef
  buildModel?: ModelRef
  task: string
  goalText: string
  goalPath?: string
  goalMtimeMs?: number
  goalWarned: boolean
  cycles: number
  maxCycles: number
  budgetMs?: number
  deadline?: number
  emptyRounds: number
  challenging: boolean
  overflowed: boolean
  handoffs: number
  lastAssistantID?: string
  capturePending: boolean
  restore: boolean
  processing: boolean
  watchdog?: ReturnType<typeof setTimeout>
}

const PLAN_AGENT = "keeprun-plan"
const BUILD_AGENT = "build"
const DEFAULT_MAX_CYCLES = 20
const CHALLENGER_EMPTY_LIMIT = 5
const MAX_HANDOFFS = 5
const GOAL_DOC_CHAR_LIMIT = 16 * 1024
const WATCHDOG_MS = 30 * 60 * 1000

const CONTEXT_ERROR_RE = /context limit|exceeds the context|context length|too many tokens|maximum context/i
const HANDOFF_MARK = "KEEPRUN_HANDOFF"

const MARK_START = "KEEPRUN_START"
const MARK_READY = "KEEPRUN_PLAN_READY"
const MARK_DONE = "KEEPRUN_DONE"
const MARK_BLOCKED = "KEEPRUN_BLOCKED"

const HARDEN = [
  { permission: "doom_loop", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "deny" },
]

const UNHARDEN = [
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "allow" },
]

function parseModel(value?: string | null): ModelRef | undefined {
  if (!value) return undefined
  const i = value.indexOf("/")
  if (i <= 0 || i >= value.length - 1) return undefined
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) }
}

export function parseDuration(value?: string | null): number | undefined {
  if (!value) return undefined
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim())
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => (x ? Number(x) : 0))
  const ms = (((d * 24 + h) * 60 + mi) * 60 + s) * 1000
  return ms > 0 ? ms : undefined
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (d) parts.push(d + "d")
  if (h) parts.push(h + "h")
  if (m) parts.push(m + "m")
  if (s || parts.length === 0) parts.push(s + "s")
  return parts.join("")
}

function parseArgs(raw: string) {
  let planModel: ModelRef | undefined
  let buildModel: ModelRef | undefined
  let max: number | undefined
  let forMs: number | undefined
  let forInvalid = false
  let goal: string | undefined
  let task = raw || ""
  task = task.replace(/--plan-model=(\S+)/g, (_, v) => {
    planModel = parseModel(v)
    return ""
  })
  task = task.replace(/--build-model=(\S+)/g, (_, v) => {
    buildModel = parseModel(v)
    return ""
  })
  task = task.replace(/--max=(\d+)/g, (_, v) => {
    max = Number(v)
    return ""
  })
  task = task.replace(/--for=(\S*)/g, (_, v) => {
    forMs = parseDuration(v)
    if (!forMs) forInvalid = true
    return ""
  })
  task = task.replace(/--goal=(?:"([^"]*)"|'([^']*)'|(\S+))/g, (_, q1, q2, q3) => {
    goal = q1 !== undefined ? q1 : q2 !== undefined ? q2 : q3
    return ""
  })
  task = task.replace(/\s+/g, " ").trim()
  return { task, planModel, buildModel, max, forMs, forInvalid, goal }
}

function unwrap(res: any): any {
  if (res && typeof res === "object" && ("data" in res || "error" in res)) return res.data
  return res
}

function failed(res: any): boolean {
  return !!(res && typeof res === "object" && "error" in res && res.error)
}

function errText(error: any): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error.data?.message) return String(error.data.message)
  if (error.message) return String(error.message)
  if (error.name) return String(error.name)
  return JSON.stringify(error)
}

function isContextError(error: any): boolean {
  if (!error) return false
  const name = error.name || error.data?.name
  if (name === "ContextOverflowError") return true
  return CONTEXT_ERROR_RE.test(errText(error))
}

function markerOf(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
  for (const line of lines) {
    const cleaned = line
      .replace(/^[>*#`_\-\s]+/, "")
      .replace(/[`_*\s]+$/, "")
      .replace(/[.。!！]+$/, "")
      .trim()
    if (cleaned === MARK_DONE) return MARK_DONE
    if (cleaned === MARK_READY) return MARK_READY
    if (cleaned === MARK_START) return MARK_START
    if (cleaned === MARK_BLOCKED || cleaned.startsWith(MARK_BLOCKED)) return MARK_BLOCKED
  }
  return undefined
}

export default async function Keeprun(input: any) {
  const client = input?.client
  const states = new Map<string, St>()
  const defaultPlanModel = parseModel(process.env.KEEPRUN_PLAN_MODEL)
  const envMax = Number(process.env.KEEPRUN_MAX_CYCLES)
  const defaultMax = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_CYCLES
  const defaultBudget = parseDuration(process.env.KEEPRUN_FOR)
  const envGoal = process.env.KEEPRUN_GOAL
  const directory: string | undefined = input?.directory

  async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      if (client?.tui?.showToast) {
        await client.tui.showToast({
          body: { title: "keeprun", message, variant, duration: 6000 },
        })
      }
    } catch {}
  }

  async function setPermissions(sessionID: string, rules: any[]) {
    try {
      await client.session.update({
        path: { id: sessionID },
        body: { permission: rules } as any,
      })
    } catch {}
  }

  async function loadMessages(sessionID: string, limit = 12): Promise<any[]> {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { limit },
      })
      const data = unwrap(res)
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  async function lastAssistant(sessionID: string): Promise<any | undefined> {
    const list = await loadMessages(sessionID)
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.info?.role === "assistant") return list[i]
    }
    return undefined
  }

  async function lastUserModel(sessionID: string): Promise<ModelRef | undefined> {
    const list = await loadMessages(sessionID, 24)
    for (let i = list.length - 1; i >= 0; i--) {
      const info = list[i]?.info
      if (info?.role === "user" && info.model?.providerID && info.model?.modelID) {
        return { providerID: info.model.providerID, modelID: info.model.modelID }
      }
    }
    return undefined
  }

  function clearWatchdog(st: St) {
    if (st.watchdog) {
      clearTimeout(st.watchdog)
      st.watchdog = undefined
    }
  }

  async function restoreSession(sessionID: string, st: St, note: string) {
    await setPermissions(sessionID, UNHARDEN)
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: BUILD_AGENT,
          ...(st.buildModel ? { model: st.buildModel } : {}),
          noReply: true,
          parts: [{ type: "text", text: note, synthetic: true }],
        },
      })
    } catch {}
  }

  async function needsRestore(sessionID: string, st: St): Promise<boolean> {
    const list = await loadMessages(sessionID, 4)
    for (let i = list.length - 1; i >= 0; i--) {
      const info = list[i]?.info
      if (info?.role !== "user") continue
      if (info.agent && info.agent !== BUILD_AGENT) return true
      if (
        st.buildModel &&
        (info.model?.providerID !== st.buildModel.providerID || info.model?.modelID !== st.buildModel.modelID)
      ) {
        return true
      }
      return false
    }
    return false
  }

  async function stop(sessionID: string, st: St, reason: string) {
    if (states.get(sessionID) !== st) return
    states.delete(sessionID)
    st.active = false
    clearWatchdog(st)
    const done = reason.includes("complete")
    await toast("stopped: " + reason, done ? "success" : "warning")
    if (await needsRestore(sessionID, st)) {
      await restoreSession(sessionID, st, "KEEPRUN stopped (" + reason + "). Session restored to build.")
    } else {
      await setPermissions(sessionID, UNHARDEN)
    }
  }

  async function dispatch(sessionID: string, st: St, body: any) {
    clearWatchdog(st)
    st.watchdog = setTimeout(() => {
      const current = states.get(sessionID)
      if (current && current === st && current.active) {
        stop(sessionID, current, "watchdog timeout").catch(() => {})
      }
    }, WATCHDOG_MS)
    try {
      const res = await client.session.promptAsync({ path: { id: sessionID }, body })
      if (failed(res)) throw res.error
    } catch (error) {
      await stop(sessionID, st, "prompt failed: " + errText(error))
    }
  }

  function timeLeft(st: St): string | undefined {
    if (!st.deadline) return undefined
    return fmtDuration(st.deadline - Date.now())
  }

  async function resolveGoal(raw: string | undefined, task: string) {
    const value = (raw || "").trim()
    if (!value) return { text: task, path: undefined as string | undefined, mtimeMs: undefined as number | undefined }
    if (!value.startsWith("@")) return { text: value, path: undefined as string | undefined, mtimeMs: undefined as number | undefined }
    const rel = value.slice(1)
    const full = isAbsolute(rel) ? rel : resolve(directory || process.cwd(), rel)
    try {
      const [content, info] = await Promise.all([readFile(full, "utf8"), stat(full)])
      const clipped =
        content.length > GOAL_DOC_CHAR_LIMIT
          ? content.slice(0, GOAL_DOC_CHAR_LIMIT) + "\n\n[goal document truncated]"
          : content
      return { text: clipped.trim() || task, path: full, mtimeMs: info.mtimeMs }
    } catch (error) {
      await toast("goal document not readable: " + rel + " (" + errText(error) + "); falling back to the task text", "warning")
      return { text: task, path: undefined as string | undefined, mtimeMs: undefined as number | undefined }
    }
  }

  async function checkGoalChanged(st: St) {
    if (!st.goalPath || st.goalWarned) return
    try {
      const info = await stat(st.goalPath)
      if (st.goalMtimeMs !== undefined && info.mtimeMs !== st.goalMtimeMs) {
        st.goalWarned = true
        await toast("goal document changed after start; the original goal snapshot stays in effect", "warning")
      }
    } catch {}
  }

  function goalLines(st: St): string[] {
    return [
      "",
      "Ultimate goal:",
      st.goalText,
      ...(st.goalPath ? ["Goal source: " + st.goalPath + " (immutable snapshot taken at start; do not modify it)"] : []),
    ]
  }

  async function sendPlan(sessionID: string, st: St) {
    st.phase = "plan"
    await checkGoalChanged(st)
    const progress =
      st.cycles === 0
        ? "No build step has run yet."
        : "Build has run " + st.cycles + " step(s); see the conversation above for the latest results."
    const left = timeLeft(st)
    const text = [
      "KEEPRUN planning phase.",
      "",
      "Task: " + st.task,
      ...goalLines(st),
      "",
      "State: " + progress,
      ...(left ? ["Time budget remaining: " + left + ". Keep making concrete progress until the budget is exhausted."] : []),
      "",
      "Produce the single next concrete step that requires no user decision.",
      "You are read-only: do not modify anything and do not ask questions.",
      "End with KEEPRUN_PLAN_READY, or KEEPRUN_DONE if the whole task is already complete and verified, or KEEPRUN_BLOCKED: <question> if a human decision is genuinely required.",
    ].join("\n")
    await dispatch(sessionID, st, {
      agent: PLAN_AGENT,
      ...(st.planModel ? { model: st.planModel } : {}),
      parts: [{ type: "text", text }],
    })
  }

  async function sendBuild(sessionID: string, st: St) {
    st.phase = "build"
    st.challenging = false
    st.emptyRounds = 0
    await checkGoalChanged(st)
    const left = timeLeft(st)
    const text = [
      "KEEPRUN build phase.",
      ...goalLines(st),
      "",
      ...(left ? ["Time budget remaining: " + left + ". Keep making concrete progress until the budget is exhausted."] : []),
      "Execute exactly the next step described in the planner's last message above.",
      "Work autonomously: do not ask questions, make reasonable assumptions, and verify the result (build/tests) before finishing.",
      "If the ENTIRE task is complete and verified, end with KEEPRUN_DONE on its own final line.",
      "Otherwise end with KEEPRUN_CONTINUE on its own final line.",
    ].join("\n")
    await dispatch(sessionID, st, {
      agent: BUILD_AGENT,
      ...(st.buildModel ? { model: st.buildModel } : {}),
      parts: [{ type: "text", text }],
    })
  }

  async function sendChallenge(sessionID: string, st: St) {
    st.phase = "plan"
    await checkGoalChanged(st)
    const left = timeLeft(st) || "unknown"
    const text = [
      "KEEPRUN challenger phase.",
      "",
      "Task: " + st.task,
      ...goalLines(st),
      "",
      "The previous objective was reported complete (KEEPRUN_DONE), but the time budget still has " + left + " remaining. Do not stop.",
      "Judge progress against the ULTIMATE GOAL above and keep pushing toward it.",
      "Act as a strict adversarial reviewer of everything done so far in this conversation.",
      "Interrogate the result: what is untested, fragile, incomplete, slow, insecure, or unclear? What would a demanding reviewer reject? What follow-up work is genuinely valuable for reaching the ultimate goal?",
      ...(st.emptyRounds > 0
        ? [
            "A previous challenger round also found nothing. Probe harder: this is empty round " +
              (st.emptyRounds + 1) +
              " of " +
              CHALLENGER_EMPTY_LIMIT +
              ".",
          ]
        : []),
      "Challenge dimensions: correctness edge cases, test coverage, error handling, performance, code quality/maintainability, documentation, and adjacent improvements.",
      "You must propose the single most valuable next task. Output KEEPRUN_DONE only if you can concretely justify that no valuable work remains; that is a last resort.",
      "You are read-only: do not modify anything and do not ask questions.",
      "End with KEEPRUN_PLAN_READY, or KEEPRUN_DONE if (and only if) nothing of value remains, or KEEPRUN_BLOCKED: <question>.",
    ].join("\n")
    await dispatch(sessionID, st, {
      agent: PLAN_AGENT,
      ...(st.planModel ? { model: st.planModel } : {}),
      parts: [{ type: "text", text }],
    })
  }

  async function sendHandoff(sessionID: string, st: St) {
    st.phase = "handoff"
    await checkGoalChanged(st)
    const left = timeLeft(st)
    const text = [
      "KEEPRUN handoff phase.",
      "",
      "This session reached its context limit. Write a handoff document for the NEXT session so keeprun can continue without losing state.",
      "",
      "Task: " + st.task,
      ...goalLines(st),
      "",
      "State: " + st.cycles + " build step(s) completed so far.",
      ...(left ? ["Time budget remaining: " + left + "."] : []),
      "",
      "The document must cover:",
      "1. The ultimate goal (restate it) and the immediate task.",
      "2. What has been completed and verified so far, with concrete evidence (files, commits, test results).",
      "3. The in-flight step and its exact state (what is done, what is not).",
      "4. Next steps in priority order toward the ultimate goal.",
      "5. Working conventions and gotchas: build/test commands, environment constraints.",
      "",
      "Do not do any new work. Plain text only. End with " + HANDOFF_MARK + " on its own final line.",
    ].join("\n")
    await dispatch(sessionID, st, {
      agent: PLAN_AGENT,
      ...(st.planModel ? { model: st.planModel } : {}),
      parts: [{ type: "text", text }],
    })
  }

  async function fallbackHandoff(sessionID: string, st: St): Promise<string> {
    const list = await loadMessages(sessionID, 8)
    const chunks: string[] = []
    for (const m of list) {
      const text = (m?.parts || [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text || "")
        .join(" ")
        .trim()
      if (text) chunks.push(String(m?.info?.role || "?") + ": " + text.slice(0, 1200))
    }
    return [
      "Handoff generated by the keeprun plugin (the model-written handoff was unavailable).",
      "",
      "Ultimate goal: " + st.goalText,
      ...(st.goalPath ? ["Goal source: " + st.goalPath] : []),
      "Task: " + st.task,
      "Cycles completed: " + st.cycles,
      ...(st.deadline ? ["Time budget remaining: " + fmtDuration(st.deadline - Date.now())] : []),
      "",
      "Recent transcript:",
      ...chunks,
    ].join("\n")
  }

  async function startHandoff(sessionID: string, st: St, compact: boolean) {
    st.overflowed = false
    st.handoffs += 1
    if (st.handoffs > MAX_HANDOFFS) {
      return await stop(sessionID, st, "too many context handoffs (" + MAX_HANDOFFS + ")")
    }
    await toast("context limit reached; preparing handoff (" + st.handoffs + "/" + MAX_HANDOFFS + ")", "info")
    if (compact) {
      const model = st.buildModel || st.planModel
      if (model) {
        try {
          const res = await client.session.summarize({
            path: { id: sessionID },
            body: { providerID: model.providerID, modelID: model.modelID },
          })
          if (failed(res)) throw res.error
        } catch (error) {
          await toast("auto-compact failed: " + errText(error) + "; using fallback handoff if needed", "warning")
        }
      }
    }
    await sendHandoff(sessionID, st)
  }

  async function migrateToNewSession(oldID: string, st: St, doc: string) {
    let newID: string | undefined
    try {
      const res = await client.session.create({ body: { title: "keeprun: " + st.task.slice(0, 60) } })
      if (failed(res)) throw res.error
      newID = unwrap(res)?.id
      if (!newID) throw new Error("session.create returned no id")
    } catch (error) {
      return await stop(oldID, st, "handoff failed: " + errText(error))
    }

    states.delete(oldID)
    st.lastAssistantID = undefined
    st.phase = "plan"
    st.overflowed = false
    st.processing = false
    clearWatchdog(st)
    states.set(newID, st)
    await setPermissions(newID, HARDEN)

    const contextText = [
      "KEEPRUN handoff context from the previous session (that session hit its context limit).",
      "",
      "Task: " + st.task,
      ...goalLines(st),
      ...(st.deadline ? ["", "Time budget remaining: " + fmtDuration(st.deadline - Date.now()) + "."] : []),
      "",
      "Handoff document:",
      doc,
    ].join("\n")
    try {
      await client.session.promptAsync({
        path: { id: newID },
        body: {
          agent: BUILD_AGENT,
          ...(st.buildModel ? { model: st.buildModel } : {}),
          noReply: true,
          parts: [{ type: "text", text: contextText, synthetic: true }],
        },
      })
    } catch {}

    await sendPlan(newID, st)
    await toast("keeprun handed off to a new session: " + newID + " (" + st.handoffs + "/" + MAX_HANDOFFS + ")", "success")
    try {
      await restoreSession(oldID, st, "KEEPRUN continued in a new session " + newID + " (context refreshed).")
    } catch {}
  }

  async function onIdle(sessionID: string) {
    const st = states.get(sessionID)
    if (!st) return

    if (!st.active) {
      if (st.restore) {
        st.restore = false
        states.delete(sessionID)
        await restoreSession(sessionID, st, "KEEPRUN stopped. Session restored to build.")
      }
      return
    }

    if (st.processing) return
    st.processing = true
    try {
      const last = await lastAssistant(sessionID)
      if (!last) return
      const id = last.info?.id
      if (!id || id === st.lastAssistantID) return
      st.lastAssistantID = id
      clearWatchdog(st)

      if (st.deadline && Date.now() >= st.deadline) {
        return await stop(sessionID, st, "time budget exhausted (" + fmtDuration(st.budgetMs || 0) + ")")
      }

      if (!st.buildModel) st.buildModel = await lastUserModel(sessionID)

      const error = last.info?.error
      if (error) {
        const name = error.name || error.data?.name
        if (name === "MessageAbortedError") return await stop(sessionID, st, "aborted")
        if (name === "ProviderAuthError") return await stop(sessionID, st, "provider auth error")
        if (name === "MessageOutputLengthError") {
          if (st.phase === "plan") return await stop(sessionID, st, "planner output truncated")
        } else if (isContextError(error)) {
          if (st.phase === "handoff") {
            return await migrateToNewSession(sessionID, st, await fallbackHandoff(sessionID, st))
          }
          return await startHandoff(sessionID, st, true)
        } else {
          return await stop(sessionID, st, "assistant error: " + (name || "unknown"))
        }
      }

      if (st.overflowed) {
        return await startHandoff(sessionID, st, false)
      }

      const text = (last.parts || [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text || "")
        .join("\n")
      const mark = markerOf(text)

      if (st.phase === "handoff") {
        const doc = text
          .split(/\r?\n/)
          .filter(
            (line) =>
              line
                .trim()
                .replace(/^[>*#`_\-\s]+/, "")
                .replace(/[`_*\s]+$/, "") !== HANDOFF_MARK,
          )
          .join("\n")
          .trim()
        return await migrateToNewSession(sessionID, st, doc || (await fallbackHandoff(sessionID, st)))
      }

      if (st.phase === "ack") {
        await sendPlan(sessionID, st)
        return
      }
      if (st.phase === "plan") {
        if (mark === MARK_BLOCKED) return await stop(sessionID, st, "needs human decision (planner)")
        if (mark === MARK_DONE) {
          if (!st.deadline) return await stop(sessionID, st, "task complete (planner)")
          if (st.challenging) {
            st.emptyRounds += 1
            if (st.emptyRounds >= CHALLENGER_EMPTY_LIMIT) {
              return await stop(
                sessionID,
                st,
                "challenger found no further work (" + (timeLeft(st) || "?") + " left)",
              )
            }
          }
          st.challenging = true
          await toast("objective complete; challenger round (" + (timeLeft(st) || "?") + " left)", "info")
          return await sendChallenge(sessionID, st)
        }
        await sendBuild(sessionID, st)
        return
      }
      if (st.phase === "build") {
        st.cycles += 1
        if (mark === MARK_DONE) {
          if (!st.deadline) return await stop(sessionID, st, "task complete")
          st.challenging = true
          st.emptyRounds = 0
          await toast("objective complete; challenger round (" + (timeLeft(st) || "?") + " left)", "info")
          return await sendChallenge(sessionID, st)
        }
        if (st.cycles >= st.maxCycles) {
          return await stop(sessionID, st, "max cycles reached (" + st.maxCycles + ")")
        }
        await sendPlan(sessionID, st)
      }
    } finally {
      st.processing = false
    }
  }

  return {
    "command.execute.before": async (hook: any, output: any) => {
      const name = String(hook?.command || "").replace(/^\//, "")
      const sessionID = hook?.sessionID
      if (!sessionID) return

      if (name === "keepstop") {
        const st = states.get(sessionID)
        if (!st) {
          await toast("keeprun is not active", "info")
          return
        }
        st.active = false
        st.restore = true
        clearWatchdog(st)
        await toast("keeprun stopping", "info")
        return
      }

      if (name !== "keeprun") return

      const parsed = parseArgs(String(hook?.arguments || ""))
      if (parsed.forInvalid) {
        await toast("invalid --for value; time budget ignored (use e.g. --for=8h)", "warning")
      }
      const budgetMs = parsed.forMs ?? defaultBudget
      const explicitMax = parsed.max && parsed.max > 0 ? parsed.max : undefined
      const maxCycles = explicitMax ?? (budgetMs ? Infinity : defaultMax)
      const taskText = parsed.task || "(continue the current conversation task)"
      const goal = await resolveGoal(parsed.goal ?? envGoal, taskText)
      const previous = states.get(sessionID)
      if (previous) clearWatchdog(previous)
      const st: St = {
        active: true,
        phase: "ack",
        planModel: parsed.planModel || defaultPlanModel,
        buildModel: parsed.buildModel,
        task: taskText,
        goalText: goal.text,
        goalPath: goal.path,
        goalMtimeMs: goal.mtimeMs,
        goalWarned: false,
        cycles: 0,
        maxCycles,
        budgetMs,
        deadline: budgetMs ? Date.now() + budgetMs : undefined,
        emptyRounds: 0,
        challenging: false,
        overflowed: false,
        handoffs: 0,
        capturePending: true,
        restore: false,
        processing: false,
      }
      states.set(sessionID, st)
      await setPermissions(sessionID, HARDEN)

      const ack = [
        "KEEPRUN is starting. Do not implement anything yet and do not use tools.",
        "Reply with exactly: " + MARK_START,
        "",
        "Task: " + st.task,
      ].join("\n")
      if (output && Array.isArray(output.parts)) {
        output.parts.length = 0
        output.parts.push({ type: "text", text: ack })
      }
      const planLabel = st.planModel
        ? st.planModel.providerID + "/" + st.planModel.modelID
        : "agent default"
      const capLabel =
        budgetMs && !explicitMax ? "no cycle cap" : "max " + st.maxCycles + " cycles"
      const budgetLabel = budgetMs ? ", " + fmtDuration(budgetMs) + " budget" : ""
      const goalLabel = st.goalPath ? ", goal " + basename(st.goalPath) : ""
      await toast(
        "keeprun active (plan " + planLabel + ", " + capLabel + budgetLabel + goalLabel + ")",
        "success",
      )
    },

    "chat.message": async (hook: any, output: any) => {
      const sessionID = hook?.sessionID
      const st = sessionID ? states.get(sessionID) : undefined
      if (!st || !st.capturePending) return
      if (output?.message?.role && output.message.role !== "user") return
      const model = output?.message?.model || hook?.model
      if (model?.providerID && model?.modelID) {
        st.buildModel = { providerID: model.providerID, modelID: model.modelID }
      }
      st.capturePending = false
    },

    event: async ({ event }: any) => {
      try {
        if (!event?.type) return
        const props = event.properties || {}
        if (event.type === "session.idle") {
          await onIdle(props.sessionID)
          return
        }
        if (event.type === "session.error") {
          if (!props.sessionID) return
          const st = states.get(props.sessionID)
          if (!st || !st.active) return
          if (isContextError(props.error)) {
            if (!st.overflowed) {
              st.overflowed = true
              await toast("context overflow; compacting, handoff after this round", "info")
            }
            return
          }
          await stop(props.sessionID, st, "session error: " + errText(props.error))
          return
        }
        if (event.type === "session.deleted") {
          const id = props.info?.id
          if (!id) return
          const st = states.get(id)
          if (st) {
            clearWatchdog(st)
            states.delete(id)
          }
        }
      } catch {}
    },
  }
}
