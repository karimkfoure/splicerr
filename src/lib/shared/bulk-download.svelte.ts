import type { SampleAsset } from "$lib/splice/types"
import { libraryBatchFlags, libraryMaterializeBatch } from "$lib/library/api"
import {
    getCachedInLibrary,
    mergeBatchFlags,
    setCachedInLibrary,
} from "$lib/library/session-cache.svelte"
import { syncPackCoversForAssets } from "$lib/shared/pack-cover"
import {
    config,
    isSamplesDirValid,
    settingsDialog,
} from "$lib/shared/config.svelte"
import { sampleRelativePath } from "$lib/shared/files.svelte"
import {
    BULK_DOWNLOAD_SPLICE_PAGE_SIZE,
    browseStore,
    captureBulkSpliceListingSort,
    captureSpliceSearchFilters,
    fetchSpliceSearchCursorPage,
    getSpliceQueryIdentity,
    type BulkSpliceListingSort,
    type SpliceSearchFilters,
} from "$lib/shared/store.svelte"
import {
    getActiveDownloadSessionTag,
    releaseDownloadSession,
    tryClaimDownloadSession,
} from "$lib/shared/download-session"
import { toast } from "$lib/shared/toast.svelte"
import { terminalLog } from "$lib/shared/terminal-log"
import {
    BULK_DOWNLOAD_CONCURRENCY_MAX,
    BULK_DOWNLOAD_CONCURRENCY_MIN,
    bulkDownloadHealthSnapshot,
    bulkDownloadMetricsLine,
    getBulkDownloadConcurrency,
    onBulkDownloadStallDetected,
    recordBulkDownloadSliceOutcome,
    resetBulkDownloadHealth,
} from "$lib/shared/bulk-download-health"

const LIBRARY_FLAGS_CHUNK = 200
const DOWNLOAD_TIMEOUT_MS = 30_000
const LISTING_FLAGS_CONCURRENCY = 4
const DOWNLOAD_MAX_ATTEMPTS = 3
/** Process this many items per slice, then log + yield the event loop. */
const DOWNLOAD_SLICE_SIZE = 250
/** Collect at most this many pending downloads per cycle, then download before continuing. */
export const BULK_DOWNLOAD_BATCH_SIZE = 5_000
const STALL_DEBUG_MS = 30_000
const PROGRESS_LOG_INTERVAL_MS = 45_000

type InFlightDownload = {
    uuid: string
    name: string
    startedAt: number
}

type BulkDownloadDebugSnapshot = {
    listingSort: BulkSpliceListingSort
    searchIdentity: string
    batchIndex: number
    batchSize: number
    cursor: string | null
    paginationDone: boolean
    cursorPages: number
    listed: number
    listedUuidsSize: number
    overflowQueueLen: number
    inFlight: InFlightDownload[]
}

function formatStallDebugReport(
    label: string,
    progress: { completed: number; total: number },
    snap: BulkDownloadDebugSnapshot
): string {
    const now = Date.now()
    const identityNow = getSpliceQueryIdentity()
    const lines = [
        `[bulk-download stall] ${label}`,
        `at: ${new Date().toISOString()}`,
        `progress: completed=${progress.completed} total=${progress.total} sessionSaved=${bulkDownloadState.sessionSaved} failed=${bulkDownloadState.failed}`,
        `phase=${bulkDownloadState.phase} scanned=${bulkDownloadState.scanned} reportedTotal=${bulkDownloadState.reportedTotal} truncated=${bulkDownloadState.listingTruncated}`,
        `batch: index=${snap.batchIndex} size=${snap.batchSize} concurrency=${getBulkDownloadConcurrency()} cap=${BULK_DOWNLOAD_CONCURRENCY_MAX} timeoutMs=${DOWNLOAD_TIMEOUT_MS}`,
        `health: ${JSON.stringify(bulkDownloadHealthSnapshot())}`,
        `pagination: done=${snap.paginationDone} pages=${snap.cursorPages} listed=${snap.listed} uuids=${snap.listedUuidsSize} overflow=${snap.overflowQueueLen}`,
        `cursor: ${snap.cursor ?? "(null)"}`,
        `sort: ${snap.listingSort.sort} order=${snap.listingSort.order} random_seed=${snap.listingSort.random_seed ?? "(null)"}`,
        `identity frozen match: ${identityNow === snap.searchIdentity}`,
        `identity frozen len: ${snap.searchIdentity.length} now len: ${identityNow.length}`,
        `inFlight (${snap.inFlight.length}):`,
        ...snap.inFlight.slice(0, 12).map(
            (d) =>
                `  - ${d.uuid} | ${d.name} | ${Math.round((now - d.startedAt) / 1000)}s`
        ),
    ]
    if (snap.inFlight.length > 12) {
        lines.push(`  … +${snap.inFlight.length - 12} more`)
    }
    return lines.join("\n")
}

function createPeriodicProgressLogger(
    line: () => string,
    isActive: () => boolean
) {
    const timer = window.setInterval(() => {
        if (!isActive()) return
        void terminalLog(`[bulk-download progress] ${line()}`, "info")
    }, PROGRESS_LOG_INTERVAL_MS)
    return () => window.clearInterval(timer)
}

function createStallMonitor(
    getSnapshot: () => BulkDownloadDebugSnapshot,
    readProgress: () => { completed: number; total: number },
    phaseLabel: () => string
) {
    let lastBeat = Date.now()
    let lastReport = 0

    const timer = window.setInterval(() => {
        if (!bulkDownloadState.running) return

        const stalledFor = Date.now() - lastBeat
        if (stalledFor < STALL_DEBUG_MS) return
        if (Date.now() - lastReport < STALL_DEBUG_MS) return

        lastReport = Date.now()
        const progress = readProgress()
        const report = formatStallDebugReport(
            `${phaseLabel()} (no heartbeat ${stalledFor}ms at ${progress.completed}/${progress.total})`,
            progress,
            getSnapshot()
        )
        const nextConcurrency = onBulkDownloadStallDetected()
        void terminalLog(report, "error")
        void terminalLog(
            bulkDownloadMetricsLine("stall_self_heal", {
                concurrency: nextConcurrency,
                stalledForMs: stalledFor,
                phase: phaseLabel(),
            }),
            "warn"
        )
    }, 2_000)

    return {
        beat: () => {
            lastBeat = Date.now()
        },
        stop: () => window.clearInterval(timer),
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("Download timed out")),
            ms
        )
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (error) => {
                clearTimeout(timer)
                reject(error)
            }
        )
    })
}

export const bulkDownloadState = $state({
    running: false,
    stopRequested: false,
    phase: "idle" as "idle" | "listing" | "downloading",
    /** Current batch: queue size while listing, or download total while downloading. */
    total: 0,
    completed: 0,
    failed: 0,
    /** Samples saved across all batches in this run. */
    sessionSaved: 0,
    listingTruncated: false,
    /** Results walked this run (includes already in library). */
    scanned: 0,
    /** `response_metadata.records` from the current search. */
    reportedTotal: 0,
    /** Live adaptive download parallelism (for UI / logs). */
    downloadConcurrency: 50,
})

export function requestStopBulkDownload() {
    if (!bulkDownloadState.running) return
    bulkDownloadState.stopRequested = true
    toast("Stopping after the current step…", { variant: "info" })
}

export function beginBulkDownloadJob() {
    bulkDownloadState.stopRequested = false
    bulkDownloadState.running = true
    bulkDownloadState.phase = "listing"
    bulkDownloadState.total = 0
    bulkDownloadState.completed = 0
    bulkDownloadState.failed = 0
    bulkDownloadState.sessionSaved = 0
    bulkDownloadState.listingTruncated = false
    bulkDownloadState.scanned = 0
    bulkDownloadState.reportedTotal = 0
    resetBulkDownloadHealth()
    bulkDownloadState.downloadConcurrency = getBulkDownloadConcurrency()
}

export function endBulkDownloadJob() {
    bulkDownloadState.running = false
    bulkDownloadState.phase = "idle"
    bulkDownloadState.stopRequested = false
}

export type SpliceDownloadSearchContext = {
    filters?: SpliceSearchFilters
    parentPackUuid?: string | null
}

export type SpliceDownloadListingResult = {
    listed: number
    totalRecords: number
    sessionFailed: number
    aborted: boolean
    listedUuids: Set<string>
}

function filterMissingFromFlags(
    chunk: SampleAsset[],
    batch: Awaited<ReturnType<typeof libraryBatchFlags>>
): SampleAsset[] {
    const out: SampleAsset[] = []
    for (const asset of chunk) {
        const flags = batch[asset.uuid]
        const inLibrary =
            flags?.inLibrary ?? getCachedInLibrary(asset.uuid)
        if (!inLibrary) out.push(asset)
    }
    return out
}

async function assetsNotInLibrary(
    assets: SampleAsset[]
): Promise<SampleAsset[]> {
    if (!assets.length) return []
    const chunks: SampleAsset[][] = []
    for (let i = 0; i < assets.length; i += LIBRARY_FLAGS_CHUNK) {
        chunks.push(assets.slice(i, i + LIBRARY_FLAGS_CHUNK))
    }
    const missingByChunk: SampleAsset[][] = chunks.map(() => [])
    const indexed = chunks.map((chunk, chunkIndex) => ({ chunk, chunkIndex }))
    await runPool(indexed, LISTING_FLAGS_CONCURRENCY, async ({
        chunk,
        chunkIndex,
    }) => {
        const batch = await libraryBatchFlags(chunk.map((a) => a.uuid))
        mergeBatchFlags(batch)
        missingByChunk[chunkIndex] = filterMissingFromFlags(chunk, batch)
    })
    return missingByChunk.flat()
}

async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
) {
    if (!items.length) return
    let next = 0
    const runWorker = async () => {
        while (true) {
            const index = next++
            if (index >= items.length) break
            await worker(items[index])
        }
    }
    const n = Math.min(concurrency, items.length)
    await Promise.all(Array.from({ length: n }, runWorker))
}

async function materializeSliceWithRetry(
    slice: SampleAsset[],
    isAborted: () => boolean,
    concurrency: number,
    onSaved: (count: number) => void,
    onFailed: () => void
): Promise<{ timedOut: boolean }> {
    let timedOut = false
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
        if (isAborted()) {
            return { timedOut }
        }
        try {
            if (!config.samples_dir) {
                throw new Error("Samples directory not set")
            }
            await withTimeout(
                libraryMaterializeBatch({
                    samplesDir: config.samples_dir,
                    concurrency,
                    items: slice.map((asset) => ({
                        asset,
                        relativeAudioPath: sampleRelativePath(asset),
                    })),
                }).then((result) => {
                    const ok = result.saved + result.alreadyCached
                    if (result.failed > 0) {
                        throw new Error(
                            `Batch materialize failed for ${result.failed} item(s): ${result.failures.slice(0, 3).join(" | ")}`
                        )
                    }
                    for (const asset of slice) setCachedInLibrary(asset.uuid, true)
                    onSaved(ok)
                }),
                Math.max(DOWNLOAD_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS * slice.length)
            )
            return { timedOut }
        } catch (e) {
            const isTimeout =
                e instanceof Error && e.message === "Download timed out"
            if (isTimeout) timedOut = true
            const detail = e instanceof Error ? e.message : String(e)
            if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
                void terminalLog(
                    `bulk-download: retry ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} for slice (${slice.length} items): ${detail}`,
                    "warn"
                )
                await new Promise((r) => setTimeout(r, 1500 * attempt))
                continue
            }
            console.error("Bulk download slice failed", e)
            void terminalLog(
                `bulk-download: gave up on slice (${slice.length} items) after ${DOWNLOAD_MAX_ATTEMPTS} attempts: ${detail}`,
                "error"
            )
            for (const _asset of slice) onFailed()
        }
    }
    return { timedOut }
}

async function downloadBatch(
    batch: SampleAsset[],
    isAborted: () => boolean,
    onFailed: () => void,
    onSaved: (count: number) => void,
    batchIndex: number,
    inFlightHolder: { items: InFlightDownload[] },
    onHeartbeat: () => void
) {
    bulkDownloadState.phase = "downloading"
    bulkDownloadState.total = batch.length
    bulkDownloadState.completed = 0
    onHeartbeat()

    let batchTimeouts = 0
    let batchFailures = 0
    const inFlight = new Map<string, InFlightDownload>()

    const syncInFlight = () => {
        inFlightHolder.items = [...inFlight.values()]
    }

    const onFailedTracked = () => {
        batchFailures++
        onFailed()
    }

    try {
        for (let offset = 0; offset < batch.length; offset += DOWNLOAD_SLICE_SIZE) {
            const slice = batch.slice(offset, offset + DOWNLOAD_SLICE_SIZE)
            const sliceStart = Date.now()
            const failuresAtSliceStart = batchFailures
            let sliceTimeouts = 0
            const concurrency = getBulkDownloadConcurrency()
            bulkDownloadState.downloadConcurrency = concurrency
            for (const asset of slice) {
                inFlight.set(asset.uuid, {
                    uuid: asset.uuid,
                    name: asset.name,
                    startedAt: Date.now(),
                })
            }
            syncInFlight()
            try {
                const { timedOut } = await materializeSliceWithRetry(
                    slice,
                    isAborted,
                    concurrency,
                    onSaved,
                    onFailedTracked
                )
                if (timedOut) {
                    batchTimeouts++
                    sliceTimeouts++
                }
            } finally {
                inFlight.clear()
                syncInFlight()
                bulkDownloadState.completed += slice.length
                onHeartbeat()
            }
            const sliceMs = Date.now() - sliceStart
            const adjust = recordBulkDownloadSliceOutcome({
                items: slice.length,
                timeouts: sliceTimeouts,
                failures: batchFailures - failuresAtSliceStart,
                durationMs: sliceMs,
            })
            bulkDownloadState.downloadConcurrency = adjust.concurrency
            await terminalLog(
                `bulk-download: batch ${batchIndex} slice ${Math.min(offset + slice.length, batch.length)}/${batch.length} completed=${bulkDownloadState.completed} sessionSaved=${bulkDownloadState.sessionSaved} concurrency=${adjust.concurrency}`,
                "info"
            )
            if (adjust.adjusted) {
                await terminalLog(
                    bulkDownloadMetricsLine("concurrency_adjusted", {
                        batchIndex,
                        concurrency: adjust.concurrency,
                        reason: adjust.reason ?? "unknown",
                        sliceTimeouts,
                        sliceMs,
                    }),
                    "warn"
                )
            }
            await terminalLog(
                bulkDownloadMetricsLine("slice_complete", {
                    batchIndex,
                    sliceItems: slice.length,
                    sliceTimeouts,
                    sliceMs,
                    concurrency: adjust.concurrency,
                    sessionSaved: bulkDownloadState.sessionSaved,
                }),
                "info"
            )
            onHeartbeat()
            await new Promise((r) => setTimeout(r, 0))
        }
    } finally {
        inFlightHolder.items = []
    }

    await syncPackCoversForAssets(batch)

    await terminalLog(
        `bulk-download: batch ${batchIndex} finished completed=${bulkDownloadState.completed} failed=${bulkDownloadState.failed} timeouts=${batchTimeouts}`,
        "info"
    )

    if (batchTimeouts > 0) {
        toast(
            `${batchTimeouts.toLocaleString()} download(s) in this batch timed out (retries exhausted).`,
            { variant: "warning", durationMs: 12_000 }
        )
    }
}

export async function runSpliceDownloadListingSession(options: {
    listingSort: BulkSpliceListingSort
    searchContext: SpliceDownloadSearchContext
    identityForLogs: string
    shouldAbort: () => boolean
    listedUuids?: Set<string>
    batchIndex?: { value: number }
    onProgress?: () => void
}): Promise<SpliceDownloadListingResult> {
    const listingSort = options.listingSort
    const searchContext = options.searchContext
    const identityForLogs = options.identityForLogs
    const listedUuids = options.listedUuids ?? new Set<string>()
    const batchIndex = options.batchIndex ?? { value: 0 }

    let cursor: string | null = null
    let paginationDone = false
    let totalRecords = Number.POSITIVE_INFINITY
    let listed = 0
    let cursorPages = 0
    let sawNextCursor = false
    let overflowQueue: SampleAsset[] = []
    let sessionFailed = 0
    let warnedNoCursor = false
    const inFlightHolder = { items: [] as InFlightDownload[] }

    const debugSnapshot = (): BulkDownloadDebugSnapshot => ({
        listingSort,
        searchIdentity: identityForLogs,
        batchIndex: batchIndex.value,
        batchSize: bulkDownloadState.total,
        cursor,
        paginationDone,
        cursorPages,
        listed,
        listedUuidsSize: listedUuids.size,
        overflowQueueLen: overflowQueue.length,
        inFlight: inFlightHolder.items,
    })

    const readProgress = () =>
        bulkDownloadState.phase === "listing"
            ? {
                  completed: bulkDownloadState.scanned,
                  total: bulkDownloadState.reportedTotal,
              }
            : {
                  completed: bulkDownloadState.completed,
                  total: bulkDownloadState.total,
              }

    const stallMonitor = createStallMonitor(
        debugSnapshot,
        readProgress,
        () => bulkDownloadState.phase
    )

    const heartbeat = () => {
        stallMonitor.beat()
        options.onProgress?.()
    }

    const isAborted = () => options.shouldAbort()

    try {
        while (true) {
            if (isAborted()) {
                return {
                    listed,
                    totalRecords,
                    sessionFailed,
                    aborted: true,
                    listedUuids,
                }
            }

            const toDownload: SampleAsset[] = [...overflowQueue]
            overflowQueue = []
            bulkDownloadState.phase = "listing"
            bulkDownloadState.total = toDownload.length
            bulkDownloadState.completed = 0

            while (
                toDownload.length < BULK_DOWNLOAD_BATCH_SIZE &&
                !paginationDone
            ) {
                if (isAborted()) {
                    return {
                        listed,
                        totalRecords,
                        sessionFailed,
                        aborted: true,
                        listedUuids,
                    }
                }

                const pageResult = await fetchSpliceSearchCursorPage(
                    cursor,
                    BULK_DOWNLOAD_SPLICE_PAGE_SIZE,
                    listingSort,
                    searchContext
                )
                if (!pageResult) {
                    toast(
                        "Could not load results from Splice. Try again later.",
                        { variant: "error" }
                    )
                    paginationDone = true
                    break
                }
                if (!pageResult.items.length) {
                    paginationDone = true
                    break
                }

                totalRecords = pageResult.totalRecords
                cursorPages++

                const fresh = pageResult.items.filter(
                    (a) => !listedUuids.has(a.uuid)
                )
                if (fresh.length === 0) {
                    if (!pageResult.nextCursor) {
                        paginationDone = true
                        break
                    }
                    cursor = pageResult.nextCursor
                    sawNextCursor = true
                    continue
                }

                for (const a of fresh) listedUuids.add(a.uuid)
                listed += fresh.length
                bulkDownloadState.scanned = listed
                bulkDownloadState.reportedTotal = totalRecords

                const missing = await assetsNotInLibrary(fresh)
                for (const asset of missing) {
                    if (toDownload.length < BULK_DOWNLOAD_BATCH_SIZE) {
                        toDownload.push(asset)
                    } else {
                        overflowQueue.push(asset)
                    }
                }
                bulkDownloadState.total = toDownload.length
                heartbeat()

                if (!pageResult.nextCursor) {
                    paginationDone = true
                    break
                }

                sawNextCursor = true
                cursor = pageResult.nextCursor

                if (toDownload.length >= BULK_DOWNLOAD_BATCH_SIZE) {
                    break
                }
            }

            if (
                !warnedNoCursor &&
                cursorPages === 1 &&
                !sawNextCursor &&
                totalRecords > listed &&
                !searchContext.parentPackUuid
            ) {
                warnedNoCursor = true
                toast(
                    "Splice did not return a pagination cursor. Deep results may be capped near 10k — use Sample pack sync for full packs.",
                    { variant: "warning", durationMs: 14_000 }
                )
            }

            if (toDownload.length === 0) {
                if (paginationDone) break
                continue
            }

            batchIndex.value++
            void terminalLog(
                `bulk-download: batch ${batchIndex.value} download ${toDownload.length} items (sessionSaved=${bulkDownloadState.sessionSaved}) identity=${identityForLogs}`,
                "info"
            )
            heartbeat()
            await downloadBatch(
                toDownload,
                isAborted,
                () => {
                    sessionFailed++
                    bulkDownloadState.failed++
                },
                (count) => {
                    bulkDownloadState.sessionSaved += count
                    if (bulkDownloadState.sessionSaved % 500 === 0) {
                        void terminalLog(
                            `bulk-download: heartbeat saved=${bulkDownloadState.sessionSaved} batch=${batchIndex.value} ${bulkDownloadState.completed}/${bulkDownloadState.total}`,
                            "info"
                        )
                    }
                },
                batchIndex.value,
                inFlightHolder,
                heartbeat
            )

            if (isAborted()) {
                return {
                    listed,
                    totalRecords,
                    sessionFailed,
                    aborted: true,
                    listedUuids,
                }
            }

            if (paginationDone && overflowQueue.length === 0) break
        }

        return {
            listed,
            totalRecords,
            sessionFailed,
            aborted: false,
            listedUuids,
        }
    } finally {
        stallMonitor.stop()
    }
}

export async function downloadAllSpliceResults() {
    if (bulkDownloadState.running) return
    if (getActiveDownloadSessionTag() === "pack-sync") {
        toast("Pack sync is running. Stop it before Download all.", {
            variant: "info",
        })
        return
    }
    if (browseStore.mode !== "splice") return
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }

    if (!tryClaimDownloadSession("bulk-download")) {
        toast("Pack sync is running. Stop it before Download all.", {
            variant: "info",
        })
        return
    }

    const searchIdentity = getSpliceQueryIdentity()
    const listingSort = captureBulkSpliceListingSort()
    beginBulkDownloadJob()

    const listedUuids = new Set<string>()
    const batchIndex = { value: 0 }

    await terminalLog(
        `bulk-download: started concurrency=${getBulkDownloadConcurrency()} (adaptive ${BULK_DOWNLOAD_CONCURRENCY_MIN}-${BULK_DOWNLOAD_CONCURRENCY_MAX}) slice=${DOWNLOAD_SLICE_SIZE} collectBatch=${BULK_DOWNLOAD_BATCH_SIZE} splicePage=${BULK_DOWNLOAD_SPLICE_PAGE_SIZE}`,
        "info"
    )

    const stopProgressLog = createPeriodicProgressLogger(
        () =>
            `phase=${bulkDownloadState.phase} batch=${batchIndex.value} ` +
            `batchProgress=${bulkDownloadState.completed}/${bulkDownloadState.total} ` +
            `sessionSaved=${bulkDownloadState.sessionSaved} failed=${bulkDownloadState.failed} ` +
            `scanned=${bulkDownloadState.scanned}/${bulkDownloadState.reportedTotal} ` +
            `concurrency=${bulkDownloadState.downloadConcurrency}`,
        () => bulkDownloadState.running
    )

    let result: SpliceDownloadListingResult = {
        listed: 0,
        totalRecords: 0,
        sessionFailed: 0,
        aborted: false,
        listedUuids,
    }

    try {
        result = await runSpliceDownloadListingSession({
            listingSort,
            searchContext: { filters: captureSpliceSearchFilters() },
            identityForLogs: searchIdentity,
            shouldAbort: () =>
                bulkDownloadState.stopRequested ||
                getSpliceQueryIdentity() !== searchIdentity,
            listedUuids,
            batchIndex,
        })

        if (
            result.aborted &&
            !bulkDownloadState.stopRequested &&
            getSpliceQueryIdentity() !== searchIdentity
        ) {
            toast("Bulk download stopped because the search changed.", {
                variant: "info",
            })
        }

        if (!result.aborted && result.listed < result.totalRecords) {
            bulkDownloadState.listingTruncated = true
            toast(
                `Listing stopped early: found ${result.listed.toLocaleString()} of ${result.totalRecords.toLocaleString()} reported matches. Downloads only included what was listed.`,
                { variant: "warning", durationMs: 14_000 }
            )
        }

        if (result.aborted && bulkDownloadState.stopRequested) {
            toast(
                `Download stopped. ${bulkDownloadState.sessionSaved.toLocaleString()} sample(s) saved this session.`,
                { variant: "info" }
            )
            return
        }

        const saved = bulkDownloadState.sessionSaved
        if (saved === 0 && result.sessionFailed === 0) {
            toast(
                result.listed < result.totalRecords
                    ? "Nothing new to download from the listed results."
                    : "All matching samples are already in your library.",
                { variant: "info" }
            )
        } else if (result.sessionFailed > 0) {
            toast(
                `Download finished: ${saved.toLocaleString()} saved, ${result.sessionFailed.toLocaleString()} failed.`,
                { variant: "warning", durationMs: 12_000 }
            )
        } else {
            toast(`Download finished: ${saved.toLocaleString()} samples saved.`, {
                variant: "success",
            })
        }
    } finally {
        stopProgressLog()
        endBulkDownloadJob()
        releaseDownloadSession("bulk-download")
    }
}
