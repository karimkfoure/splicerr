import { localAudioWaveform, type LocalWaveformResult } from "$lib/library/api"
import { config } from "$lib/shared/config.svelte"
import { BoundedWorkerQueue } from "$lib/shared/bounded-worker-queue"

const MAX_CACHE_ENTRIES = 600
const cache = new Map<string, LocalWaveformResult>()
const workers = new BoundedWorkerQueue(2)

function remember(key: string, result: LocalWaveformResult) {
    cache.delete(key)
    cache.set(key, result)
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
    }
}

export function loadLocalWaveform(
    relativeAudioPath: string,
    signal?: AbortSignal
) {
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
    return workers.run(
        async () => {
            if (signal?.aborted) {
                throw new DOMException("Waveform request canceled", "AbortError")
            }
            const result = await localAudioWaveform({
                samplesDir: config.samples_dir!,
                relativeAudioPath,
            })
            remember(key, result)
            return result
        },
        signal
    )
}
