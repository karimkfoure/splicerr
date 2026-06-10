import type { PackAsset } from "$lib/splice/types"
import {
    libraryBatchFlags,
    libraryPackMirrorStats,
    librarySetPackListableTotal,
    type PackMirrorStats,
} from "$lib/library/api"
import { mergeBatchFlags } from "$lib/library/session-cache.svelte"
import { isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import {
    beginBulkDownloadJob,
    bulkDownloadState,
    endBulkDownloadJob,
    runSpliceDownloadListingSession,
} from "$lib/shared/bulk-download.svelte"
import {
    bulkDownloadHealthSnapshot,
    getBulkDownloadConcurrency,
    resetBulkDownloadHealth,
} from "$lib/shared/bulk-download-health"
import {
    getActiveDownloadSessionTag,
    releaseDownloadSession,
    tryClaimDownloadSession,
} from "$lib/shared/download-session"
import {
    captureBulkSpliceListingSort,
    captureSpliceSearchFilters,
    fetchSpliceSearchCursorPage,
    packDisplayName,
    type BulkSpliceListingSort,
    type SpliceSearchFilters,
} from "$lib/shared/store.svelte"
import {
    isPackMirrorComplete,
    isPackSyncCatalogComplete,
    packMirrorTargetTotal,
    splicePackSampleTotal,
} from "$lib/splice/pack-stats"
import { toast } from "$lib/shared/toast.svelte"
import { terminalLog } from "$lib/shared/terminal-log"
import { inLibraryState } from "$lib/library/session-cache.svelte"

export function packCachedCount(
    packUuid: string,
    fallback: Record<string, number>
): number {
    return packSyncManager.rows[packUuid]?.cached ?? fallback[packUuid] ?? 0
}

export function packListableTotal(
    packUuid: string,
    fallback: Record<string, number | null | undefined>
): number | null {
    const fromRow = packSyncManager.rows[packUuid]?.listableTotal
    if (fromRow != null && fromRow > 0) return fromRow
    const fb = fallback[packUuid]
    return fb != null && fb > 0 ? fb : null
}

/** One pack at a time — each pack uses the same engine as Download all. */
export const PACK_SYNC_PARALLEL = 1
const LIBRARY_FLAGS_CHUNK = 200
const PACK_SYNC_QUEUE_WARN = 15
const PROGRESS_LOG_INTERVAL_MS = 45_000

export type PackSyncPhase =
    | "idle"
    | "queued"
    | "listing"
    | "downloading"
    | "done"
    | "error"
    | "cancelled"

export type PackSyncRow = {
    phase: PackSyncPhase
    spliceTotal: number | null
    catalogTotal: number | null
    /** Sample-search `records` for this pack (persisted in SQLite when known). */
    listableTotal: number | null
    cached: number
    listed: number
    listedInLibrary: number
    syncListingComplete: boolean
    savedRun: number
    failedRun: number
    batchTotal: number
    batchDone: number
    error?: string
    lastFailure?: string
}

export const packSyncManager = $state({
    active: false,
    stopRequested: false,
    jobId: 0,
    rows: {} as Record<string, PackSyncRow>,
    queue: [] as PackAsset[],
    sessionSaved: 0,
    sessionFailed: 0,
    sessionStartedAt: 0,
    /** Pack currently running through bulk listing session. */
    currentPackUuid: null as string | null,
    /** When true, pack listing uses `dataStore.tags` merged into browse filters. */
    matchBrowseTags: true,
})

let jobSerial = 0
let runnerPromise: Promise<void> | null = null
let packSyncWorkWaiters: Array<() => void> = []

function notifyPackSyncWorkers() {
    const waiters = packSyncWorkWaiters
    packSyncWorkWaiters = []
    for (const w of waiters) w()
}

function hasQueuedPacks(): boolean {
    return packSyncManager.queue.some(
        (p) => packSyncManager.rows[p.uuid]?.phase === "queued"
    )
}

function waitForPackSyncWork(jobId: number): Promise<void> {
    if (shouldStop(jobId) || hasQueuedPacks()) return Promise.resolve()
    return new Promise((resolve) => {
        packSyncWorkWaiters.push(resolve)
    })
}

function packSyncSearchFilters(): SpliceSearchFilters {
    const base = captureSpliceSearchFilters()
    if (packSyncManager.matchBrowseTags) return base
    return { ...base, tags: [] }
}

function ensureRow(pack: PackAsset, cached: number) {
    if (packSyncManager.rows[pack.uuid]) return
    packSyncManager.rows[pack.uuid] = {
        phase: "idle",
        spliceTotal: splicePackSampleTotal(pack),
        catalogTotal: null,
        listableTotal: null,
        cached,
        listed: 0,
        listedInLibrary: 0,
        syncListingComplete: false,
        savedRun: 0,
        failedRun: 0,
        batchTotal: 0,
        batchDone: 0,
    }
}

function patchRow(uuid: string, patch: Partial<PackSyncRow>) {
    const cur = packSyncManager.rows[uuid]
    if (!cur) return
    packSyncManager.rows = {
        ...packSyncManager.rows,
        [uuid]: { ...cur, ...patch },
    }
}

export function getPackSyncRow(uuid: string): PackSyncRow | undefined {
    return packSyncManager.rows[uuid]
}

export function requestStopPackSync() {
    if (!packSyncManager.active && packSyncManager.queue.length === 0) return
    packSyncManager.stopRequested = true
    notifyPackSyncWorkers()
}

function shouldStop(jobId: number) {
    return packSyncManager.stopRequested || packSyncManager.jobId !== jobId
}

async function countListedInLibrary(uuids: string[]): Promise<number> {
    if (!uuids.length) return 0
    let count = 0
    for (let i = 0; i < uuids.length; i += LIBRARY_FLAGS_CHUNK) {
        const chunk = uuids.slice(i, i + LIBRARY_FLAGS_CHUNK)
        const batch = await libraryBatchFlags(chunk)
        mergeBatchFlags(batch)
        for (const uuid of chunk) {
            if (batch[uuid]?.inLibrary) count++
        }
    }
    return count
}

export function isPackSyncCompleteForPack(
    pack: PackAsset,
    cachedCount: number,
    row: PackSyncRow | undefined,
    _fallbackTotal?: number | null
): boolean {
    const listable = row?.listableTotal ?? row?.catalogTotal ?? null
    if (isPackMirrorComplete(pack, cachedCount, listable)) return true
    if (isPackSyncCatalogComplete(row)) return true
    return false
}

const probeListingSort: BulkSpliceListingSort = {
    sort: "popularity",
    order: "DESC",
    random_seed: null,
}

const fullPackSearchFilters = (): SpliceSearchFilters => ({
    query: "",
    tags: [],
    asset_category_slug: null,
    bpm: null,
    min_bpm: null,
    max_bpm: null,
    key: null,
    chord_type: null,
    pack_uuid: null,
})

async function probePackListableTotal(pack: PackAsset): Promise<number | null> {
    const page = await fetchSpliceSearchCursorPage(
        null,
        1,
        probeListingSort,
        {
            filters: fullPackSearchFilters(),
            parentPackUuid: pack.uuid,
        }
    )
    const total = page?.totalRecords
    if (total == null || total <= 0) return null
    await librarySetPackListableTotal(pack.uuid, total)
    const row = packSyncManager.rows[pack.uuid]
    if (row) {
        patchRow(pack.uuid, {
            listableTotal: total,
            catalogTotal: row.catalogTotal ?? total,
        })
    }
    return total
}

async function probeListableTotalsWhereNeeded(packs: PackAsset[]) {
    for (const pack of packs) {
        const row = packSyncManager.rows[pack.uuid]
        if (row?.listableTotal != null && row.listableTotal > 0) continue
        const cached = row?.cached ?? 0
        if (cached <= 0) continue
        const meta = splicePackSampleTotal(pack)
        if (meta != null && cached >= meta) continue
        await probePackListableTotal(pack)
    }
}

function syncActivePackRowFromBulk(packUuid: string) {
    if (packSyncManager.currentPackUuid !== packUuid) return
    const phase =
        bulkDownloadState.phase === "downloading" ? "downloading" : "listing"
    patchRow(packUuid, {
        phase,
        listed: bulkDownloadState.scanned,
        catalogTotal:
            bulkDownloadState.reportedTotal > 0
                ? bulkDownloadState.reportedTotal
                : packSyncManager.rows[packUuid]?.catalogTotal ?? null,
        batchTotal: bulkDownloadState.total,
        batchDone: bulkDownloadState.completed,
    })
}

async function runPackViaBulkSession(
    pack: PackAsset,
    jobId: number,
    batchIndex: { value: number }
) {
    const uuid = pack.uuid
    const packLabel = packDisplayName(pack.name)
    packSyncManager.currentPackUuid = uuid

    const savedBefore = bulkDownloadState.sessionSaved
    const failedBefore = bulkDownloadState.failed

    patchRow(uuid, {
        phase: "listing",
        listed: 0,
        batchTotal: 0,
        batchDone: 0,
        lastFailure: undefined,
    })

    void terminalLog(
        `pack-sync: pack start pack=${packLabel} uuid=${uuid} (bulk-download engine)`,
        "info"
    )

    let result
    try {
        result = await runSpliceDownloadListingSession({
            listingSort: captureBulkSpliceListingSort(),
            searchContext: {
                filters: packSyncSearchFilters(),
                parentPackUuid: uuid,
            },
            identityForLogs: `pack:${uuid}`,
            shouldAbort: () => shouldStop(jobId),
            batchIndex,
            onProgress: () => syncActivePackRowFromBulk(uuid),
        })
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        patchRow(uuid, { phase: "error", error: detail })
        void terminalLog(`pack-sync: pack ${uuid} failed: ${detail}`, "error")
        return
    } finally {
        if (packSyncManager.currentPackUuid === uuid) {
            packSyncManager.currentPackUuid = null
        }
    }

    const savedDelta = bulkDownloadState.sessionSaved - savedBefore
    const savedRun = savedDelta
    const failedRun = Math.max(0, bulkDownloadState.failed - failedBefore)

    packSyncManager.sessionSaved += savedDelta
    packSyncManager.sessionFailed += failedRun

    const listedArr = [...result.listedUuids]
    const stats = await libraryPackMirrorStats([uuid])
    const cached = stats[uuid]?.cached ?? 0
    const listedInLibrary = await countListedInLibrary(listedArr)
    const catalogTotal =
        bulkDownloadState.reportedTotal > 0
            ? bulkDownloadState.reportedTotal
            : packSyncManager.rows[uuid]?.catalogTotal ?? null
    const metadataTotal = splicePackSampleTotal(pack)

    const searchTotal =
        catalogTotal != null && catalogTotal > 0
            ? catalogTotal
            : metadataTotal != null && metadataTotal > 0
              ? metadataTotal
              : null

    const syncListingComplete =
        !result.aborted &&
        !shouldStop(jobId) &&
        searchTotal != null &&
        searchTotal > 0 &&
        result.listed >= searchTotal

    const listableTotal =
        catalogTotal != null && catalogTotal > 0
            ? catalogTotal
            : syncListingComplete && result.listed > 0
              ? result.listed
              : packSyncManager.rows[uuid]?.listableTotal ?? null

    if (syncListingComplete && listableTotal != null && listableTotal > 0) {
        await librarySetPackListableTotal(uuid, listableTotal)
    }

    patchRow(uuid, {
        cached,
        listed: result.listed,
        listedInLibrary,
        syncListingComplete,
        listableTotal,
        spliceTotal:
            packSyncManager.rows[uuid]?.spliceTotal ?? metadataTotal ?? null,
        catalogTotal: catalogTotal ?? listableTotal,
        savedRun,
        failedRun,
        phase: shouldStop(jobId) || result.aborted ? "cancelled" : "done",
    })

    inLibraryState.version += 1

    if (failedRun > 0) {
        void terminalLog(
            `pack-sync: pack done pack=${packLabel} saved=${savedRun} failed=${failedRun}`,
            "warn"
        )
    } else {
        void terminalLog(`pack-sync: pack done pack=${packLabel}`, "info")
    }
}

function dequeuePack(): PackAsset | undefined {
    while (packSyncManager.queue.length > 0) {
        const pack = packSyncManager.queue.shift()!
        const row = packSyncManager.rows[pack.uuid]
        if (row?.phase === "queued") return pack
    }
    return undefined
}

async function runPackSyncLoop(jobId: number) {
    const batchIndex = { value: 0 }
    beginBulkDownloadJob()

    try {
        while (!shouldStop(jobId)) {
            const pack = dequeuePack()
            if (!pack) {
                if (!hasQueuedPacks() && packSyncManager.queue.length === 0) {
                    break
                }
                await waitForPackSyncWork(jobId)
                continue
            }
            await runPackViaBulkSession(pack, jobId, batchIndex)
        }
    } finally {
        packSyncManager.currentPackUuid = null
        endBulkDownloadJob()
    }
}

async function ensureRunner() {
    if (runnerPromise) return runnerPromise

    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }

    if (getActiveDownloadSessionTag() === "bulk-download") {
        toast("Download all is running. Stop it before pack sync.", {
            variant: "info",
        })
        return
    }

    jobSerial += 1
    const jobId = jobSerial
    packSyncManager.jobId = jobId
    packSyncManager.stopRequested = false

    const progressTimer = window.setInterval(() => {
        if (!packSyncManager.active) return
        void terminalLog(
            `[pack-sync progress] saved=${packSyncManager.sessionSaved} failed=${packSyncManager.sessionFailed} queued=${packSyncManager.queue.length} pack=${packSyncManager.currentPackUuid ?? "—"} concurrency=${getBulkDownloadConcurrency()} health=${JSON.stringify(bulkDownloadHealthSnapshot())}`,
            "info"
        )
    }, PROGRESS_LOG_INTERVAL_MS)

    runnerPromise = (async () => {
        if (!tryClaimDownloadSession("pack-sync")) {
            runnerPromise = null
            window.clearInterval(progressTimer)
            toast("Download all is running. Stop it before pack sync.", {
                variant: "info",
            })
            return
        }

        resetBulkDownloadHealth()
        packSyncManager.active = true
        packSyncManager.sessionStartedAt = Date.now()
        packSyncManager.sessionSaved = 0
        packSyncManager.sessionFailed = 0

        await terminalLog(
            `pack-sync: started (serial packs, bulk-download engine per pack)`,
            "info"
        )
        try {
            await runPackSyncLoop(jobId)
        } finally {
            window.clearInterval(progressTimer)
            releaseDownloadSession("pack-sync")
            packSyncWorkWaiters = []
            const saved = packSyncManager.sessionSaved
            const failed = packSyncManager.sessionFailed
            const stopped = packSyncManager.stopRequested
            packSyncManager.active = false
            packSyncManager.currentPackUuid = null
            packSyncManager.queue = []
            runnerPromise = null
            void terminalLog(
                `pack-sync: finished saved=${saved} failed=${failed} health=${JSON.stringify(bulkDownloadHealthSnapshot())}`,
                failed > 0 ? "warn" : "info"
            )
            if (stopped) {
                toast(
                    `Pack sync stopped. ${saved.toLocaleString()} sample(s) saved.`,
                    { variant: "info" }
                )
            } else if (failed > 0) {
                toast(
                    `Pack sync finished: ${saved.toLocaleString()} saved, ${failed.toLocaleString()} failed. See terminal or bulk-download-debug.log for details.`,
                    { variant: "warning", durationMs: 14_000 }
                )
            } else if (saved > 0) {
                toast(
                    `Pack sync finished: ${saved.toLocaleString()} sample(s) saved.`,
                    { variant: "success" }
                )
            }
        }
    })()

    return runnerPromise
}

export async function refreshPackMirrorStats(
    packs: PackAsset[]
): Promise<Record<string, PackMirrorStats>> {
    if (!isSamplesDirValid() || !packs.length) return {}
    const stats = await libraryPackMirrorStats(packs.map((p) => p.uuid))
    for (const pack of packs) {
        const s = stats[pack.uuid] ?? { cached: 0, listableTotal: null }
        ensureRow(pack, s.cached)
        patchRow(pack.uuid, {
            cached: s.cached,
            listableTotal: s.listableTotal,
            catalogTotal:
                s.listableTotal ??
                packSyncManager.rows[pack.uuid]?.catalogTotal ??
                null,
            spliceTotal:
                packSyncManager.rows[pack.uuid]?.spliceTotal ??
                splicePackSampleTotal(pack),
        })
    }
    void probeListableTotalsWhereNeeded(packs)
    return stats
}

/** @deprecated use refreshPackMirrorStats */
export async function refreshPackCachedCounts(
    packs: PackAsset[]
): Promise<Record<string, number>> {
    const stats = await refreshPackMirrorStats(packs)
    return Object.fromEntries(
        Object.entries(stats).map(([uuid, s]) => [uuid, s.cached])
    )
}

export function enqueuePackSync(
    packs: PackAsset[],
    cachedByUuid: Record<string, number>,
    options?: { matchBrowseTags?: boolean }
) {
    if (!packs.length) return
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }
    if (getActiveDownloadSessionTag() === "bulk-download") {
        toast("Download all is running. Stop it before pack sync.", {
            variant: "info",
        })
        return
    }

    if (options?.matchBrowseTags !== undefined) {
        packSyncManager.matchBrowseTags = options.matchBrowseTags
    }

    const toQueue: PackAsset[] = []
    for (const pack of packs) {
        const cached = cachedByUuid[pack.uuid] ?? 0
        ensureRow(pack, cached)
        const row = packSyncManager.rows[pack.uuid]
        if (isPackSyncCompleteForPack(pack, cached, row)) continue
        if (
            row &&
            (row.phase === "queued" ||
                row.phase === "listing" ||
                row.phase === "downloading")
        ) {
            continue
        }
        patchRow(pack.uuid, {
            phase: "queued",
            syncListingComplete: false,
            listedInLibrary: 0,
            savedRun: 0,
            failedRun: 0,
            lastFailure: undefined,
        })
        toQueue.push(pack)
    }

    if (!toQueue.length) return
    const queuedAfter = packSyncManager.queue.length + toQueue.length
    if (queuedAfter >= PACK_SYNC_QUEUE_WARN) {
        toast(
            `${queuedAfter} packs queued for sync — expect a long run. Prefer smaller batches or restart Tauri after code changes.`,
            { variant: "info", durationMs: 12_000 }
        )
    }
    packSyncManager.queue = [...packSyncManager.queue, ...toQueue]
    notifyPackSyncWorkers()
    void ensureRunner()
}

export function enqueueSinglePackSync(
    pack: PackAsset,
    cached: number,
    options?: { matchBrowseTags?: boolean }
) {
    enqueuePackSync([pack], { [pack.uuid]: cached }, options)
}
