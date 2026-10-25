import assert from "node:assert"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { parseDuration, fmtDuration } from "../plugins/keeprun.ts"

delete process.env.KEEPRUN_FOR
delete process.env.KEEPRUN_PLAN_MODEL
delete process.env.KEEPRUN_MAX_CYCLES
delete process.env.KEEPRUN_GOAL
delete process.env.KEEPRUN_OUT
delete process.env.KEEPRUN_SUMMARY

const realExit = process.exit.bind(process)
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

const HARDEN = [
  { permission: "doom_loop", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "deny" },
]
const UNHARDEN = [
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "allow" },
]

await check("parseDuration accepts units and combinations", () => {
  assert.equal(parseDuration("8h"), 8 * 3600 * 1000)
  assert.equal(parseDuration("45m"), 45 * 60 * 1000)
  assert.equal(parseDuration("30s"), 30 * 1000)
  assert.equal(parseDuration("1d"), 24 * 3600 * 1000)
  assert.equal(parseDuration("1h30m"), 90 * 60 * 1000)
  assert.equal(parseDuration("2d8h"), (2 * 24 + 8) * 3600 * 1000)
})

await check("parseDuration rejects invalid values", () => {
  assert.equal(parseDuration("8"), undefined)
  assert.equal(parseDuration("abc"), undefined)
  assert.equal(parseDuration(""), undefined)
  assert.equal(parseDuration("0m"), undefined)
  assert.equal(parseDuration("1h30"), undefined)
})

await check("fmtDuration renders compact durations", () => {
  assert.equal(fmtDuration(8 * 3600 * 1000), "8h")
  assert.equal(fmtDuration(90 * 60 * 1000), "1h30m")
  assert.equal(fmtDuration(1000), "1s")
  assert.equal(fmtDuration(0), "0s")
  assert.equal(fmtDuration(90061000), "1d1h1m1s")
})

let fakeNow = 1_700_000_000_000
Date.now = () => fakeNow

function harness() {
  const h = {
    sessions: new Map(),
    prompts: [],
    toasts: [],
    permission: {},
    created: [],
    summarized: [],
    seq: 0,
  }
  h.messagesFor = (id) => {
    if (!h.sessions.has(id)) h.sessions.set(id, [])
    return h.sessions.get(id)
  }
  h.client = {
    session: {
      update: async (req) => {
        h.permission[req.path.id] = req.body.permission
        return { data: {} }
      },
      messages: async (req) => {
        const limit = req?.query?.limit ?? 20
        return { data: h.messagesFor(req.path.id).slice(-limit) }
      },
      promptAsync: async (req) => {
        const id = req.path.id
        h.prompts.push({ sessionID: id, body: req.body })
        h.messagesFor(id).push({
          info: {
            id: "u" + h.seq++,
            role: "user",
            agent: req.body.agent,
            model: req.body.model,
          },
          parts: req.body.parts || [],
        })
        return { data: {} }
      },
      create: async (req) => {
        h.created.push(req.body)
        return { data: { id: "n" + h.created.length } }
      },
      summarize: async (req) => {
        h.summarized.push({ sessionID: req.path.id, body: req.body })
        return { data: {} }
      },
    },
    tui: {
      showToast: async (x) => {
        h.toasts.push(x.body)
      },
    },
  }
  return h
}

async function start(h, args, opts = {}) {
  const prevSummary = process.env.KEEPRUN_SUMMARY
  const prevOut = process.env.KEEPRUN_OUT
  process.env.KEEPRUN_SUMMARY = opts.summary ? "on" : "off"
  if (opts.out) process.env.KEEPRUN_OUT = opts.out
  else delete process.env.KEEPRUN_OUT
  h.instance = await plugin({ client: h.client, directory: opts.directory || process.cwd() })
  h.output = { parts: [{ type: "text", text: "placeholder" }] }
  if (prevSummary === undefined) delete process.env.KEEPRUN_SUMMARY
  else process.env.KEEPRUN_SUMMARY = prevSummary
  if (prevOut === undefined) delete process.env.KEEPRUN_OUT
  else process.env.KEEPRUN_OUT = prevOut
  await h.instance["command.execute.before"](
    { command: "keeprun", sessionID: "s1", arguments: args },
    h.output,
  )
}

function assistant(h, text, sid = "s1") {
  h.messagesFor(sid).push({
    info: { id: "a" + h.seq++, role: "assistant" },
    parts: [{ type: "text", text }],
  })
}

function assistantError(h, error, sid = "s1") {
  h.messagesFor(sid).push({
    info: { id: "a" + h.seq++, role: "assistant", error },
    parts: [],
  })
}

async function idle(h, sid = "s1") {
  await h.instance.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
}

async function emit(h, type, properties) {
  await h.instance.event({ event: { type, properties } })
}

const lastPrompt = (h) => h.prompts[h.prompts.length - 1]
const lastPromptBody = (h) => lastPrompt(h)?.body
const lastToast = (h) => h.toasts[h.toasts.length - 1]
const promptText = (body) => (body?.parts || []).map((p) => p.text || "").join("\n")
const stopped = (h) => h.toasts.some((t) => String(t.message || "").startsWith("stopped:"))
const sessionPrompts = (h, sid) => h.prompts.filter((p) => p.sessionID === sid)

await check("--for is stripped from the task and budget is advertised", async () => {
  fakeNow = 1_700_000_000_000
  const h = harness()
  await start(h, "do X --for=8h")
  const ack = promptText({ parts: h.output.parts })
  assert.match(ack, /Task: do X/)
  assert.doesNotMatch(ack, /--for/)
  const toast = lastToast(h)
  assert.match(String(toast.message), /8h budget/)
  assert.match(String(toast.message), /no cycle cap/)
})

await check("invalid --for warns and falls back to the cycle cap", async () => {
  const h = harness()
  await start(h, "do X --for=8")
  assert.ok(h.toasts.some((t) => /invalid --for/.test(String(t.message))))
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.match(String(lastToast(h).message), /stopped: task complete \(planner\)/)
})

await check("build DONE with time left starts a challenger round", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assert.equal(lastPromptBody(h).agent, "keeprun-plan")
  assistant(h, "step 1\nKEEPRUN_PLAN_READY")
  await idle(h)
  assert.equal(lastPromptBody(h).agent, "build")
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.equal(lastPromptBody(h).agent, "keeprun-plan")
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN challenger phase/)
  assert.ok(h.toasts.some((t) => /challenger round/.test(String(t.message))))
})

await check("challenger PLAN_READY resumes normal build then plan", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /challenger phase/)
  assistant(h, "follow-up work\nKEEPRUN_PLAN_READY")
  await idle(h)
  assert.equal(lastPromptBody(h).agent, "build")
  assert.doesNotMatch(promptText(lastPromptBody(h)), /challenger/)
  assistant(h, "KEEPRUN_CONTINUE")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN planning phase/)
  assert.doesNotMatch(promptText(lastPromptBody(h)), /challenger/)
})

await check("--for lifts the 20-cycle cap", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  for (let i = 0; i < 22; i++) {
    assistant(h, "KEEPRUN_PLAN_READY")
    await idle(h)
    assistant(h, "KEEPRUN_CONTINUE")
    await idle(h)
  }
  assert.equal(stopped(h), false)
  assert.ok(!h.toasts.some((t) => /max cycles/.test(String(t.message))))
})

await check("--for with explicit --max still respects the cap", async () => {
  const h = harness()
  await start(h, "do X --for=8h --max=2")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  for (let i = 0; i < 2; i++) {
    assistant(h, "KEEPRUN_PLAN_READY")
    await idle(h)
    assistant(h, "KEEPRUN_CONTINUE")
    await idle(h)
  }
  assert.match(String(lastToast(h).message), /stopped: max cycles reached \(2\)/)
})

await check("time budget expiry stops the loop", async () => {
  const h = harness()
  await start(h, "do X --for=1s")
  fakeNow += 2000
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assert.match(String(lastToast(h).message), /stopped: time budget exhausted \(1s\)/)
  assert.equal(h.prompts.filter((p) => !p.body.noReply).length, 0)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN stopped \(time budget exhausted/)
})

await check("consecutive empty challenger rounds hit the backstop", async () => {
  const h = harness()
  await start(h, "do X --for=1h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  for (let i = 0; i < 6; i++) {
    assistant(h, "KEEPRUN_DONE")
    await idle(h)
  }
  assert.match(String(lastToast(h).message), /stopped: challenger found no further work/)
  const challengeRounds = h.prompts.filter((p) => /KEEPRUN challenger phase/.test(promptText(p.body)))
  assert.equal(challengeRounds.length, 5)
  assert.equal(h.prompts.filter((p) => !p.body.noReply).length, 6)
})

await check("KEEPRUN_BLOCKED still stops under a time budget", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_BLOCKED: need credentials")
  await idle(h)
  assert.match(String(lastToast(h).message), /stopped: needs human decision/)
})

await check("--goal inline text is stripped and injected into prompts", async () => {
  const h = harness()
  await start(h, 'do X --goal="ship the feature"')
  const ack = promptText({ parts: h.output.parts })
  assert.match(ack, /Task: do X/)
  assert.doesNotMatch(ack, /--goal/)
  assert.doesNotMatch(String(lastToast(h).message), /goal /)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /Ultimate goal:\nship the feature/)
})

const goalDir = await mkdtemp(join(tmpdir(), "keeprun-goal-"))
const goalFile = join(goalDir, "goal.md")

await check("--goal=@file snapshots the document into every prompt", async () => {
  await writeFile(goalFile, "GOAL-DOC: raise ldp pairing to 95%\n")
  const h = harness()
  await start(h, "do X --goal=@" + goalFile)
  assert.match(String(lastToast(h).message), /goal goal\.md/)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  const text = promptText(lastPromptBody(h))
  assert.match(text, /Ultimate goal:\nGOAL-DOC: raise ldp pairing to 95%/)
  assert.match(text, /Goal source: .*goal\.md/)
  assert.match(text, /immutable snapshot/)
})

await check("goal document modified mid-run only warns and keeps the snapshot", async () => {
  const h = harness()
  await start(h, "do X --goal=@" + goalFile)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(goalFile, "MODIFIED GOAL\n")
  assistant(h, "KEEPRUN_PLAN_READY")
  await idle(h)
  assert.ok(h.toasts.some((t) => /goal document changed after start/.test(String(t.message))))
  const text = promptText(lastPromptBody(h))
  assert.match(text, /GOAL-DOC: raise ldp pairing to 95%/)
  assert.doesNotMatch(text, /MODIFIED GOAL/)
})

await check("missing goal document warns and falls back to the task text", async () => {
  const h = harness()
  await start(h, "do X --goal=@/nonexistent/keeprun/goal.md")
  assert.ok(h.toasts.some((t) => /goal document not readable/.test(String(t.message))))
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /Ultimate goal:\ndo X/)
})

await check("ContextOverflowError event does not stop the loop", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await emit(h, "session.error", {
    sessionID: "s1",
    error: { name: "ContextOverflowError", data: { message: "context length exceeded" } },
  })
  assert.equal(stopped(h), false)
  assert.ok(h.toasts.some((t) => /context overflow/.test(String(t.message))))
  assistant(h, "round finished after auto-compaction")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN handoff phase/)
})

await check("handoff document migrates the run to a new session", async () => {
  await writeFile(goalFile, "GOAL-DOC: raise ldp pairing to 95%\n")
  const h = harness()
  await start(h, "do X --for=8h --goal=@" + goalFile)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await emit(h, "session.error", {
    sessionID: "s1",
    error: { name: "ContextOverflowError", data: { message: "overflow" } },
  })
  assistant(h, "round finished")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN handoff phase/)
  assistant(h, "HANDOFF DOC CONTENT\nKEEPRUN_HANDOFF")
  await idle(h)

  assert.equal(h.created.length, 1)
  assert.deepEqual(h.permission["n1"], HARDEN)
  assert.deepEqual(h.permission["s1"], UNHARDEN)
  const migrated = sessionPrompts(h, "n1")
  assert.equal(migrated.length, 2)
  assert.equal(migrated[0].body.noReply, true)
  assert.match(promptText(migrated[0].body), /handoff context from the previous session/)
  assert.match(promptText(migrated[0].body), /HANDOFF DOC CONTENT/)
  assert.match(promptText(migrated[0].body), /GOAL-DOC: raise ldp pairing/)
  assert.equal(migrated[1].body.agent, "keeprun-plan")
  assert.match(promptText(migrated[1].body), /Time budget remaining: 8h/)
  assert.ok(h.toasts.some((t) => /handed off to a new session: n1/.test(String(t.message))))

  assistant(h, "KEEPRUN_PLAN_READY", "n1")
  await idle(h, "n1")
  assert.equal(lastPrompt(h).sessionID, "n1")
  assert.equal(lastPromptBody(h).agent, "build")
})

await check("unclassified context errors compact then hand off", async () => {
  const h = harness()
  await start(h, "do X --for=8h --build-model=p/m")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistantError(h, {
    name: "APIError",
    data: { message: "litellm.BadRequestError: DashscopeException - Input exceeds the context limit (1048568 tokens)" },
  })
  await idle(h)
  assert.equal(h.summarized.length, 1)
  assert.deepEqual(h.summarized[0], { sessionID: "s1", body: { providerID: "p", modelID: "m" } })
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN handoff phase/)

  assistantError(h, { name: "APIError", data: { message: "Input exceeds the context limit (1048568 tokens)" } })
  await idle(h)
  assert.equal(h.created.length, 1)
  const contextPrompt = h.prompts.find((p) => p.sessionID === "n1" && p.body.noReply)
  assert.match(promptText(contextPrompt.body), /Handoff generated by the keeprun plugin/)
})

await check("handoff attempts are capped", async () => {
  const h = harness()
  await start(h, "do X --for=8h")
  let sid = "s1"
  assistant(h, "KEEPRUN_START", sid)
  await idle(h, sid)
  for (let i = 0; i < 6; i++) {
    await emit(h, "session.error", {
      sessionID: sid,
      error: { name: "ContextOverflowError", data: { message: "overflow" } },
    })
    assistant(h, "round finished", sid)
    await idle(h, sid)
    if (stopped(h)) break
    assistant(h, "doc\nKEEPRUN_HANDOFF", sid)
    await idle(h, sid)
    sid = "n" + (i + 1)
  }
  assert.equal(h.created.length, 5)
  assert.match(String(lastToast(h).message), /stopped: too many context handoffs \(5\)/)
})

async function runDirOf(base) {
  const runs = (await readdir(base)).filter((name) => name.startsWith("run-"))
  assert.equal(runs.length, 1)
  return join(base, runs[0])
}

await check("--out collects goal.md and summary.md", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --out=" + outBase)
  const runDir = await runDirOf(outBase)
  const goal = await readFile(join(runDir, "goal.md"), "utf8")
  assert.match(goal, /do X/)
  assert.doesNotMatch(goal, /--out/)

  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assert.match(promptText(lastPromptBody(h)), /task complete/)
  assistant(h, "SUMMARY BODY\nKEEPRUN_SUMMARY")
  await idle(h)

  const summary = await readFile(join(runDir, "summary.md"), "utf8")
  assert.match(summary, /stop_reason: task complete \(planner\)/)
  assert.match(summary, /SUMMARY BODY/)
  assert.doesNotMatch(summary, /KEEPRUN_SUMMARY/)
  assert.match(summary, /cycles: 0/)
  assert.equal(stopped(h), true)
  assert.ok(h.toasts.some((t) => /summary written: .*summary\.md/.test(String(t.message))))
  assert.ok(h.toasts.some((t) => /docs .*run-/.test(String(t.message))))
  await rm(outBase, { recursive: true, force: true })
})

await check("--out writes each handoff document", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --for=8h --out=" + outBase)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await emit(h, "session.error", {
    sessionID: "s1",
    error: { name: "ContextOverflowError", data: { message: "overflow" } },
  })
  assistant(h, "round finished")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN handoff phase/)
  assistant(h, "HANDOFF BODY\nKEEPRUN_HANDOFF")
  await idle(h)

  const runDir = await runDirOf(outBase)
  const handoff = await readFile(join(runDir, "handoff-1.md"), "utf8")
  assert.match(handoff, /handoff: 1/)
  assert.match(handoff, /from: s1/)
  assert.match(handoff, /to: n1/)
  assert.match(handoff, /HANDOFF BODY/)
  await rm(outBase, { recursive: true, force: true })
})

await check("/keepstop stops after the round and writes a summary", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --out=" + outBase)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await h.instance["command.execute.before"]({ command: "keepstop", sessionID: "s1", arguments: "" }, { parts: [] })
  assert.equal(stopped(h), false)
  assistant(h, "round finished")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assert.match(promptText(lastPromptBody(h)), /stopped by user/)
  assistant(h, "STOP SUMMARY\nKEEPRUN_SUMMARY")
  await idle(h)
  const summary = await readFile(join(await runDirOf(outBase), "summary.md"), "utf8")
  assert.match(summary, /stop_reason: stopped by user/)
  assert.match(summary, /STOP SUMMARY/)
  assert.match(String(lastToast(h).message), /stopped: stopped by user/)
  await rm(outBase, { recursive: true, force: true })
})

await check("failed summary round falls back to a plugin-generated summary", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --out=" + outBase)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assistantError(h, { name: "APIError", data: { message: "boom" } })
  await idle(h)
  const summary = await readFile(join(await runDirOf(outBase), "summary.md"), "utf8")
  assert.match(summary, /keeprun 总结（插件生成）/)
  assert.match(summary, /stop_reason: task complete/)
  assert.equal(stopped(h), true)
  await rm(outBase, { recursive: true, force: true })
})

await check("summary is written to the workspace root without --out", async () => {
  const base = await mkdtemp(join(tmpdir(), "keeprun-base-"))
  const h = harness()
  await start(h, "do X", { summary: true, directory: base })
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assistant(h, "ROOT SUMMARY\nKEEPRUN_SUMMARY")
  await idle(h)
  const files = (await readdir(base)).filter((n) => /^summary-\d{8}-\d{6}(-\d+)?\.md$/.test(n))
  assert.equal(files.length, 1)
  const summary = await readFile(join(base, files[0]), "utf8")
  assert.match(summary, /ROOT SUMMARY/)
  assert.match(summary, /stop_reason: task complete/)
  await rm(base, { recursive: true, force: true })
})

await check("BLOCKED stop reason is recorded in the summary metadata", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --out=" + outBase)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_BLOCKED: need credentials")
  await idle(h)
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assistant(h, "BLOCKED SUMMARY\nKEEPRUN_SUMMARY")
  await idle(h)
  const summary = await readFile(join(await runDirOf(outBase), "summary.md"), "utf8")
  assert.match(summary, /stop_reason: needs human decision \(planner\)/)
  assert.match(summary, /BLOCKED SUMMARY/)
  await rm(outBase, { recursive: true, force: true })
})

await check("watchdog is an inactivity timeout: activity keeps the loop alive", async () => {
  const h = harness()
  await start(h, "do X --watchdog=1s")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await emit(h, "message.part.updated", { sessionID: "s1", part: { sessionID: "s1", type: "text" } })
  }
  assert.equal(stopped(h), false)
  assert.ok(!h.toasts.some((t) => /watchdog/.test(String(t.message))))
  assistant(h, "KEEPRUN_PLAN_READY")
  await idle(h)
  assert.equal(lastPromptBody(h).agent, "build")
})

await check("watchdog fires only when nothing happens", async () => {
  const outBase = await mkdtemp(join(tmpdir(), "keeprun-out-"))
  const h = harness()
  await start(h, "do X --watchdog=1s --out=" + outBase)
  assistant(h, "KEEPRUN_START")
  await idle(h)
  await new Promise((resolve) => setTimeout(resolve, 1300))
  assert.match(promptText(lastPromptBody(h)), /KEEPRUN summary phase/)
  assert.match(promptText(lastPromptBody(h)), /watchdog: no activity for 1s/)
  assistant(h, "WD SUMMARY\nKEEPRUN_SUMMARY")
  await idle(h)
  const summary = await readFile(join(await runDirOf(outBase), "summary.md"), "utf8")
  assert.match(summary, /stop_reason: watchdog: no activity for 1s/)
  assert.match(summary, /WD SUMMARY/)
  assert.equal(stopped(h), true)
  await rm(outBase, { recursive: true, force: true })
})

await check("stop reason is always recorded in the transcript", async () => {
  const h = harness()
  await start(h, "do X")
  assistant(h, "KEEPRUN_START")
  await idle(h)
  assistant(h, "KEEPRUN_PLAN_READY")
  await idle(h)
  assistant(h, "KEEPRUN_DONE")
  await idle(h)
  const users = h.messagesFor("s1").filter((m) => m.info.role === "user")
  const note = users[users.length - 1]
  assert.equal(note.info.agent, "build")
  assert.equal(promptText({ parts: note.parts }), "KEEPRUN stopped (task complete).")
})

await check("invalid --watchdog warns and is stripped from the task", async () => {
  const h = harness()
  await start(h, "do X --watchdog=8")
  assert.ok(h.toasts.some((t) => /invalid --watchdog/.test(String(t.message))))
  assert.doesNotMatch(promptText({ parts: h.output.parts }), /--watchdog/)
})

await rm(goalDir, { recursive: true, force: true })

let failed = 0
for (const r of results) {
  if (r.ok) {
    console.log("ok   - " + r.name)
  } else {
    failed += 1
    console.log("FAIL - " + r.name)
    console.log("       " + (r.error && r.error.message ? r.error.message : r.error))
  }
}
console.log("\n" + (results.length - failed) + "/" + results.length + " passed")
realExit(failed ? 1 : 0)
