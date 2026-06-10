/** Adaptive download parallelism + structured metrics for bulk runs. */

export const BULK_DOWNLOAD_CONCURRENCY_MIN = 25
export const BULK_DOWNLOAD_CONCURRENCY_MAX = 100
export const BULK_DOWNLOAD_CONCURRENCY_INITIAL = 50

export type BulkDownloadSliceOutcome = {
    items: number
    timeouts: number
    failures: number
    durationMs: number
}

export type BulkDownloadHealthSnapshot = {
    concurrency: number
    slicesCompleted: number
    consecutiveCleanSlices: number
    totalTimeouts: number
    totalFailures: number
    lastSliceTimeoutRate: number
    stallHalves: number
}

let concurrency = BULK_DOWNLOAD_CONCURRENCY_INITIAL
let slicesCompleted = 0
let consecutiveCleanSlices = 0
let totalTimeouts = 0
let totalFailures = 0
let lastSliceTimeoutRate = 0
let stallHalves = 0

export function resetBulkDownloadHealth() {
    concurrency = BULK_DOWNLOAD_CONCURRENCY_INITIAL
    slicesCompleted = 0
    consecutiveCleanSlices = 0
    totalTimeouts = 0
    totalFailures = 0
    lastSliceTimeoutRate = 0
    stallHalves = 0
}

export function getBulkDownloadConcurrency(): number {
    return concurrency
}

export function bulkDownloadHealthSnapshot(): BulkDownloadHealthSnapshot {
    return {
        concurrency,
        slicesCompleted,
        consecutiveCleanSlices,
        totalTimeouts,
        totalFailures,
        lastSliceTimeoutRate,
        stallHalves,
    }
}

function clampConcurrency(n: number): number {
    return Math.max(
        BULK_DOWNLOAD_CONCURRENCY_MIN,
        Math.min(BULK_DOWNLOAD_CONCURRENCY_MAX, n)
    )
}

/** Call when the stall monitor fires — halves concurrency for upcoming slices. */
export function onBulkDownloadStallDetected(): number {
    const prev = concurrency
    concurrency = clampConcurrency(Math.floor(concurrency / 2))
    if (concurrency < prev) stallHalves++
    return concurrency
}

export function recordBulkDownloadSliceOutcome(
    outcome: BulkDownloadSliceOutcome
): { concurrency: number; adjusted: boolean; reason?: string } {
    slicesCompleted++
    totalTimeouts += outcome.timeouts
    totalFailures += outcome.failures

    const items = Math.max(1, outcome.items)
    lastSliceTimeoutRate = outcome.timeouts / items
    const failureRate = outcome.failures / items

    const dirty =
        outcome.timeouts > 0 ||
        outcome.failures > 0 ||
        lastSliceTimeoutRate > 0.03 ||
        failureRate > 0.02

    if (dirty) {
        consecutiveCleanSlices = 0
        const prev = concurrency
        let reason: string | undefined
        if (lastSliceTimeoutRate > 0.08 || outcome.timeouts >= 5) {
            concurrency = clampConcurrency(concurrency - 8)
            reason = "high_timeout_rate"
        } else if (lastSliceTimeoutRate > 0.03 || outcome.timeouts > 0) {
            concurrency = clampConcurrency(concurrency - 4)
            reason = "timeouts"
        } else if (failureRate > 0.02) {
            concurrency = clampConcurrency(concurrency - 4)
            reason = "failures"
        }
        return {
            concurrency,
            adjusted: concurrency !== prev,
            reason,
        }
    }

    consecutiveCleanSlices++
    if (consecutiveCleanSlices >= 2) {
        const prev = concurrency
        concurrency = clampConcurrency(concurrency + 2)
        if (concurrency !== prev) {
            consecutiveCleanSlices = 0
            return { concurrency, adjusted: true, reason: "stable_slices" }
        }
    }

    return { concurrency, adjusted: false }
}

export function bulkDownloadMetricsLine(
    event: string,
    fields: Record<string, string | number | boolean | null>
): string {
    return `[bulk-download metrics] ${JSON.stringify({ event, ts: new Date().toISOString(), ...fields })}`
}
