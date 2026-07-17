type QueuedWorker = {
    resolve: () => void
    reject: (error: Error) => void
    signal?: AbortSignal
    onAbort?: () => void
}

export class BoundedWorkerQueue {
    private active = 0
    private readonly queue: QueuedWorker[] = []
    private readonly concurrency: number

    constructor(concurrency: number) {
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new Error("Worker concurrency must be a positive integer")
        }
        this.concurrency = concurrency
    }

    private acquire(signal?: AbortSignal) {
        if (signal?.aborted) {
            return Promise.reject(
                new DOMException("Queued work canceled", "AbortError")
            )
        }
        if (this.active < this.concurrency) {
            this.active += 1
            return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
            const worker: QueuedWorker = { resolve, reject, signal }
            worker.onAbort = () => {
                const index = this.queue.indexOf(worker)
                if (index >= 0) this.queue.splice(index, 1)
                reject(new DOMException("Queued work canceled", "AbortError"))
            }
            signal?.addEventListener("abort", worker.onAbort, { once: true })
            this.queue.push(worker)
        })
    }

    private release() {
        this.active -= 1
        while (this.queue.length) {
            const worker = this.queue.shift()!
            worker.signal?.removeEventListener("abort", worker.onAbort!)
            if (worker.signal?.aborted) continue
            this.active += 1
            worker.resolve()
            break
        }
    }

    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal)
        try {
            if (signal?.aborted) {
                throw new DOMException("Queued work canceled", "AbortError")
            }
            return await task()
        } finally {
            this.release()
        }
    }

    stats() {
        return { active: this.active, queued: this.queue.length }
    }
}
