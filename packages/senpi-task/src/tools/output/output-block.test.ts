import { describe, expect, test } from "bun:test"
import type { AgentToolUpdateCallback } from "@code-yeongyu/senpi"

import type { ListScope, ListedTask } from "../../manager"
import type { TaskRecord } from "../../state"
import { makeRecord } from "./__fixtures__/records"
import { runTaskOutput } from "./output"
import type { OutputManager, TaskOutputDeps, TranscriptReadResult } from "./types"

const WAIT_CONFIG = { min_ms: 1, default_ms: 50, max_ms: 100 } as const

type MutableOutputManager = Omit<OutputManager, "waitFor"> & {
  readonly waitFor: (taskId: string, options?: { readonly signal?: AbortSignal }) => Promise<TaskRecord>
  readonly waitForCalls: () => readonly string[]
}

function managerFrom(input: {
  readonly records: readonly TaskRecord[]
  readonly waitFor?: (taskId: string) => Promise<TaskRecord>
  readonly runStatsSnapshot?: (taskId: string) => import("../../state").TaskRunStats | undefined
  readonly subscribeChild?: (taskId: string, listener: (event: never) => void) => () => void
}): MutableOutputManager {
  let records = [...input.records]
  const waitForCalls: string[] = []
  return {
    get: (taskId) => records.find((record) => record.task_id === taskId),
    list(scope: ListScope): readonly ListedTask[] {
      const filtered =
        scope.scope === "all" ? records : records.filter((record) => record.parent_session_id === scope.session_id)
      return filtered.map((record) => ({ record }))
    },
    async waitFor(taskId) {
      waitForCalls.push(taskId)
      const next = await input.waitFor?.(taskId)
      if (next !== undefined) {
        records = records.map((record) => (record.task_id === taskId ? next : record))
        return next
      }
      const current = records.find((record) => record.task_id === taskId)
      if (current === undefined) throw new Error(`missing test record ${taskId}`)
      return current
    },
    waitForCalls: () => waitForCalls,
    ...(input.runStatsSnapshot === undefined ? {} : { runStatsSnapshot: input.runStatsSnapshot }),
    ...(input.subscribeChild === undefined ? {} : { subscribeChild: input.subscribeChild }),
  }
}

function depsFrom(input: {
  readonly manager: MutableOutputManager
  readonly reader?: () => TranscriptReadResult
  readonly now?: () => number
}): TaskOutputDeps {
  return {
    manager: input.manager,
    stateDir: "/tmp/state",
    waitConfig: WAIT_CONFIG,
    now: input.now ?? (() => Date.parse("2024-12-03T15:00:00.000Z")),
    transcriptReader: input.reader ?? (() => ({ entries: [], source: "none" })),
  }
}

describe("runTaskOutput block", () => {
  test("#given a blocking running child #when it starts waiting #then the live line leads with what the task is", async () => {
    const running = makeRecord({
      task_id: "st_running",
      status: "running",
      name: "task-1",
      description: "Audit the waiting line",
      category: "quick",
      resolved_model: { provider: "apitopia", model_id: "kimi-k3", display: "k", reasoning_effort: "max", source: "category" },
    })
    let resolveWait: (record: TaskRecord) => void = () => {}
    const manager = managerFrom({
      records: [running],
      waitFor: () => new Promise<TaskRecord>((resolve) => { resolveWait = resolve }),
    })
    const updates: Parameters<AgentToolUpdateCallback>[0][] = []
    const pending = runTaskOutput(
      depsFrom({ manager }),
      { task_id: "st_running", timeout_ms: 999 },
      "session-parent",
      undefined,
      (update) => { updates.push(update) },
    )

    // identity-first grammar; the partial content stays empty because senpi core paints the activity line
    expect(updates).toHaveLength(1)
    expect(updates[0]?.content).toEqual([{ type: "text", text: "" }])
    expect(updates[0]?.details).toEqual({
      kind: "waiting",
      progress: {
        activity: "Audit the waiting line · quick (apitopia/kimi-k3:max) · running",
        startedAt: Date.parse("2024-12-03T15:00:00.000Z"),
        maxWaitMs: 100,
      },
    })

    resolveWait(makeRecord({ task_id: "st_running", status: "completed", final_response: "done" }))
    expect((await pending).details.kind).toBe("status")
  })

  test("#given a blocking wait on a live child #when the child emits events #then the activity refreshes with tool turns and tps", async () => {
    const running = makeRecord({
      task_id: "st_live",
      status: "running",
      description: "Audit the waiting line",
      category: "quick",
    })
    let resolveWait: (record: TaskRecord) => void = () => {}
    let listener: ((event: never) => void) | undefined
    let unsubscribed = false
    const manager = managerFrom({
      records: [running],
      waitFor: () => new Promise<TaskRecord>((resolve) => { resolveWait = resolve }),
      runStatsSnapshot: () => ({ runtime_ms: 1_000, turns: 2, tool_calls: 3, tokens_per_second: 42 }),
      subscribeChild: (_taskId, next) => {
        listener = next
        return () => { unsubscribed = true }
      },
    })
    const updates: Parameters<AgentToolUpdateCallback>[0][] = []
    const pending = runTaskOutput(
      depsFrom({ manager }),
      { task_id: "st_live", timeout_ms: 999 },
      "session-parent",
      undefined,
      (update) => { updates.push(update) },
    )

    expect(updates).toHaveLength(1)
    listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "src/foo.ts" } } as never)
    expect(updates).toHaveLength(2)
    const refreshed = updates.at(-1)?.details
    if (refreshed?.kind !== "waiting") throw new Error("expected waiting details")
    expect(refreshed.progress.activity).toBe("Audit the waiting line · quick · turn 2 (3 tools) · running read src/foo.ts · 42 tok/s")
    expect(refreshed.currentTool).toBe("read src/foo.ts")

    listener?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Found the renderer." }] },
    } as never)
    const withLine = updates.at(-1)
    expect(withLine?.content).toEqual([{ type: "text", text: "↳ last: Found the renderer." }])
    if (withLine?.details.kind !== "waiting") throw new Error("expected waiting details")
    expect(withLine.details.lastAssistantLine).toBe("Found the renderer.")

    resolveWait(makeRecord({ task_id: "st_live", status: "completed", final_response: "done" }))
    await pending
    expect(unsubscribed).toBe(true)
  })

  test("#given omitted block on a running child #when waitFor resolves #then the terminal transcript is returned", async () => {
    const running = makeRecord({ task_id: "st_running", status: "running" })
    let resolveWait: (record: TaskRecord) => void = () => {}
    const waitFor = () =>
      new Promise<TaskRecord>((resolve) => {
        resolveWait = resolve
      })
    const manager = managerFrom({ records: [running], waitFor })
    const deps = depsFrom({
      manager,
      reader: () => ({
        entries: [{ kind: "assistant", text: "terminal transcript" }],
        source: "event-log",
      }),
    })

    const pending = runTaskOutput(deps, { task_id: "st_running", mode: "full" }, "session-parent")
    resolveWait(makeRecord({ task_id: "st_running", status: "completed", final_response: "done" }))
    const result = await pending

    expect(manager.waitForCalls()).toEqual(["st_running"])
    expect(result.details.kind).toBe("transcript")
    if (result.details.kind === "transcript") {
      expect(result.details.snapshot.status).toBe("completed")
      expect(result.details.transcript).toContain("terminal transcript")
    }
  })

  test("#given block false on a running child #when read #then it peeks without waiting", async () => {
    const running = makeRecord({ task_id: "st_running", status: "running" })
    const manager = managerFrom({
      records: [running],
      waitFor: () => Promise.reject(new Error("waitFor should not be called")),
    })
    const deps = depsFrom({ manager })

    const result = await runTaskOutput(deps, { task_id: "st_running", block: false }, "session-parent")

    expect(manager.waitForCalls()).toEqual([])
    expect(result.details.kind).toBe("status")
    if (result.details.kind === "status") {
      expect(result.details.snapshot.status).toBe("running")
    }
  })

  test("#given block true on a running child #when the timeout wins #then its waiter is aborted and removed", async () => {
    const running = makeRecord({ task_id: "st_running", status: "running" })
    let waiterCount = 0
    let onAbort: (() => void) | undefined
    const manager: MutableOutputManager = {
      get: () => running,
      list: () => [{ record: running }],
      waitFor: (_taskId, options) => new Promise<TaskRecord>((_resolve, reject) => {
        waiterCount += 1
        onAbort = () => {
          waiterCount -= 1
          reject(options?.signal?.reason)
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true })
      }),
      waitForCalls: () => [],
    }

    const result = await runTaskOutput(depsFrom({ manager }), { task_id: "st_running", timeout_ms: 1 }, "session-parent")

    expect(result.details.kind).toBe("timed_out")
    expect(waiterCount).toBe(0)
    expect(onAbort).toBeDefined()
  })

  test("#given block true on a running child #when the timeout wins #then timed_out is returned", async () => {
    let currentNow = 1000
    const running = makeRecord({ task_id: "st_running", status: "running" })
    const manager = managerFrom({
      records: [running],
      waitFor: () => new Promise<TaskRecord>(() => {}),
    })
    const deps = depsFrom({
      manager,
      now: () => currentNow,
    })

    const pending = runTaskOutput(deps, { task_id: "st_running", block: true, timeout_ms: 1 }, "session-parent")
    currentNow = 1001
    const result = await pending

    expect(result.details).toEqual({ kind: "timed_out", task_id: "st_running", waited_ms: 1 })
  })

  test("#given an already terminal child #when block true #then it returns immediately without waiting", async () => {
    const completed = makeRecord({ task_id: "st_done", status: "completed", final_response: "done" })
    const manager = managerFrom({
      records: [completed],
      waitFor: () => Promise.reject(new Error("waitFor should not be called")),
    })
    const deps = depsFrom({ manager })

    const result = await runTaskOutput(deps, { task_id: "st_done", block: true, mode: "full" }, "session-parent")

    expect(manager.waitForCalls()).toEqual([])
    expect(result.details.kind).toBe("transcript")
    if (result.details.kind === "transcript") {
      expect(result.details.snapshot.status).toBe("completed")
    }
  })
})
