import assert from "node:assert"
import plugin, { parseDuration, fmtDuration } from "../plugins/keeprun.ts"

delete process.env.KEEPRUN_FOR
delete process.env.KEEPRUN_PLAN_MODEL
delete process.env.KEEPRUN_MAX_CYCLES

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

check("parseDuration accepts units and combinations", () => {
  assert.equal(parseDuration("8h"), 8 * 3600 * 1000)
  assert.equal(parseDuration("45m"), 45 * 60 * 1000)
  assert.equal(parseDuration("30s"), 30 * 1000)
  assert.equal(parseDuration("1d"), 24 * 3600 * 1000)
  assert.equal(parseDuration("1h30m"), 90 * 60 * 1000)
  assert.equal(parseDuration("2d8h"), (2 * 24 + 8) * 3600 * 1000)
})

check("parseDuration rejects invalid values", () => {
  assert.equal(parseDuration("8"), undefined)
  assert.equal(parseDuration("abc"), undefined)
  assert.equal(parseDuration(""), undefined)
  assert.equal(parseDuration("0m"), undefined)
  assert.equal(parseDuration("1h30"), undefined)
})

check("fmtDuration renders compact durations", () => {
  assert.equal(fmtDuration(8 * 3600 * 1000), "8h")
  assert.equal(fmtDuration(90 * 60 * 1000), "1h30m")
  assert.equal(fmtDuration(1000), "1s")
  assert.equal(fmtDuration(0), "0s")
  assert.equal(fmtDuration(90061000), "1d1h1m1s")
})

let fakeNow = 1_700_000_000_000
Date.now = () => fakeNow

function harness() {
  const h = { messages: [], prompts: [], toasts: [], permission: null }
  h.client = {
    session: {
      update: async (req) => {
        h.permission = req.body.permission
        return { data: {} }
      },
      messages: async (req) => {
        const limit = req?.query?.limit ?? 20
        return { data: h.messages.slice(-limit) }
      },
      promptAsync: async (req) => {
        h.prompts.push(req.body)
        h.messages.push({
          info: { id: "u" + h.messages.length, role: "user", agent: req.body.agent, model: req.body.model },
          parts: req.body.parts || [],
        })
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
  h.instance = await plugin({ client: h.client })
  h.output = { parts: [{ type: "text", text: "placeholder" }] }
  await h.instance["command.execute.before"](
    { command: "keeprun", sessionID: "s1", arguments: args },
    h.output,
  )
}

function assistant(h, text) {
  h.messages.push({
    info: { id: "a" + h.messages.length, role: "assistant" },
    parts: [{ type: "text", text }],
  })
}

async function idle(h) {
  await h.instance.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
}

const lastPrompt = (h) => h.prompts[h.prompts.length - 1]
const lastToast = (h) => h.toasts[h.toasts.length - 1]
const promptText = (body) => (body.parts || []).map((p) => p.text || "").join("\n")
const stopped = (h) => h.toasts.some((t) => String(t.message || "").startsWith("stopped:"))

export async function run() {
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
    assert.equal(lastPrompt(h).agent, "keeprun-plan")
    assistant(h, "step 1\nKEEPRUN_PLAN_READY")
    await idle(h)
    assert.equal(lastPrompt(h).agent, "build")
    assistant(h, "KEEPRUN_DONE")
    await idle(h)
    assert.equal(lastPrompt(h).agent, "keeprun-plan")
    assert.match(promptText(lastPrompt(h)), /KEEPRUN challenger phase/)
    assert.ok(h.toasts.some((t) => /challenger round/.test(String(t.message))))
  })

  await check("challenger PLAN_READY resumes normal build then plan", async () => {
    const h = harness()
    await start(h, "do X --for=8h")
    assistant(h, "KEEPRUN_START")
    await idle(h)
    assistant(h, "KEEPRUN_DONE")
    await idle(h)
    assert.match(promptText(lastPrompt(h)), /challenger phase/)
    assistant(h, "follow-up work\nKEEPRUN_PLAN_READY")
    await idle(h)
    assert.equal(lastPrompt(h).agent, "build")
    assert.doesNotMatch(promptText(lastPrompt(h)), /challenger/)
    assistant(h, "KEEPRUN_CONTINUE")
    await idle(h)
    assert.match(promptText(lastPrompt(h)), /KEEPRUN planning phase/)
    assert.doesNotMatch(promptText(lastPrompt(h)), /challenger/)
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
    const challengeRounds = h.prompts.filter((p) => /KEEPRUN challenger phase/.test(promptText(p)))
    assert.equal(challengeRounds.length, 5)
    assert.equal(h.prompts.filter((p) => !p.noReply).length, 6)
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

  return results
}

const resultsPromise = run()
resultsPromise.then((all) => {
  let failed = 0
  for (const r of all) {
    if (r.ok) {
      console.log("ok   - " + r.name)
    } else {
      failed += 1
      console.log("FAIL - " + r.name)
      console.log("       " + (r.error && r.error.message ? r.error.message : r.error))
    }
  }
  console.log("\n" + (all.length - failed) + "/" + all.length + " passed")
  realExit(failed ? 1 : 0)
})
