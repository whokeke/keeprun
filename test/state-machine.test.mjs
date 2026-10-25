import assert from "node:assert"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { parseDuration, fmtDuration } from "../plugins/keeprun.ts"

delete process.env.KEEPRUN_FOR
delete process.env.KEEPRUN_PLAN_MODEL
delete process.env.KEEPRUN_MAX_CYCLES
delete process.env.KEEPRUN_GOAL

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

async function start(h, args) {
  h.instance = await plugin({ client: h.client, directory: process.cwd() })
  h.output = { parts: [{ type: "text", text: "placeholder" }] }
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
  assert.equal(h.prompts.length, 0)
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
