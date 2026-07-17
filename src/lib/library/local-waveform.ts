import { localAudioWaveform, type LocalWaveformResult } from "$lib/library/api"
import { config } from "$lib/shared/config.svelte"

const MAX_CACHE_ENTRIES = 600
const MAX_CONCURRENT = 2
const cache = new Map<string, LocalWaveformResult>()
const inflight = new Map<string, Promise<LocalWaveformResult>>()
const queue: Array<() => void> = []
let active = 0

function acquireWorker() {
    if (active < MAX_CONCURRENT) {
        active += 1
        return Promise.resolve()
    }
    return new Promise<void>((resolve) => queue.push(resolve)).then(() => {
        active += 1
    })
}

function releaseWorker() {
    active -= 1
    queue.shift()?.()
}

function remember(key: string, result: LocalWaveformResult) {
    cache.delete(key)
    cache.set(key, result)
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
    }
}

export function loadLocalWaveform(relativeAudioPath: string) {
    if (!config.samples_dir) {
        return Promise.reject(new Error("Samples directory is not configured"))
    }
    const key = `${config.samples_dir}\0${relativeAudioPath}`
    const cached = cache.get(key)
    if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        return Promise.resolve(cached)
    }
    const existing = inflight.get(key)
    if (existing) return existing

    const request = (async () => {
        await acquireWorker()
        try {
            const result = await localAudioWaveform({
                samplesDir: config.samples_dir!,
                relativeAudioPath,
            })
            remember(key, result)
            return result
        } finally {
            releaseWorker()
        }
    })().finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
}
