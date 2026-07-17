import assert from "node:assert/strict"
import { BoundedWorkerQueue } from "../src/lib/shared/bounded-worker-queue.ts"

const workers = new BoundedWorkerQueue(2)
const controllers = Array.from({ length: 10 }, () => new AbortController())
const releases = []
let active = 0
let maximumActive = 0
const started = []

const tasks = controllers.map((controller, index) => workers.run(async () => {
    started.push(index)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    if (index < 2) {
        await new Promise((resolve) => releases.push(resolve))
    }
    active -= 1
    return index
}, controller.signal))

await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(workers.stats(), { active: 2, queued: 8 })
for (let index = 2; index < 9; index++) controllers[index].abort()
assert.deepEqual(workers.stats(), { active: 2, queued: 1 })
releases.splice(0).forEach((release) => release())

const results = await Promise.allSettled(tasks)
assert.equal(maximumActive, 2)
assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 9])
assert.equal(results.filter((result) => result.status === "fulfilled").length, 3)
assert.equal(results.filter((result) => result.status === "rejected").length, 7)
assert.deepEqual(workers.stats(), { active: 0, queued: 0 })
console.log(JSON.stringify({ maximumActive, started, canceled: 7 }))
