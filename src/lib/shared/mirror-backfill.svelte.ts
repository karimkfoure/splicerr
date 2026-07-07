import type { SampleAsset } from "$lib/splice/types"
import {
    libraryBatchFlags,
    libraryMaterializeBatch,
    mirrorCheckpointPack,
    mirrorClaimNextPack,
    mirrorCompletePack,
    mirrorEnqueuePacks,
    mirrorFailPack,
    mirrorPauseJob,
    mirrorRetryFailed,
    mirrorStartOrResume,
    mirrorSummary,
    type MirrorSummary,
} from "$lib/library/api"
import { mergeBatchFlags, setCachedInLibrary } from "$lib/library/session-cache.svelte"
import { splicePackSampleTotal } from "$lib/splice/pack-stats"
import { config, isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import {
    BULK_DOWNLOAD_SPLICE_PAGE_SIZE,
    fetchSplicePacksPage,
    fetchSpliceSearchCursorPage,
    type BulkSpliceListingSort,
    type SpliceSearchFilters,
} from "$lib/shared/store.svelte"
import { getBulkDownloadConcurrency } from "$lib/shared/bulk-download-health"
import {
    getActiveDownloadSessionTag,
    releaseDownloadSession,
    tryClaimDownloadSession,
} from "$lib/shared/download-session"
import { sampleRelativePath } from "$lib/shared/files.svelte"
import { terminalLog } from "$lib/shared/terminal-log"
import { toast } from "$lib/shared/toast.svelte"

const PACKS_PAGE_SIZE = 50
const SAMPLE_FLAGS_CHUNK = 200
const PAGE_MAX_ATTEMPTS = 3

const fullPackFilters = (): SpliceSearchFilters => ({
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

const packListingSort: BulkSpliceListingSort = {
    sort: "popularity",
    order: "DESC",
    random_seed: null,
}

export const mirrorBackfillState = $state({
    running: false,
    stopRequested: false,
    phase: "idle" as "idle" | "catalog" | "pack" | "paused",
    catalogPage: 0,
    catalogTotalPages: 0,
    currentPackName: null as string | null,
    currentPackUuid: null as string | null,
    currentPackListed: 0,
    currentPackTotal: 0,
    currentPackSaved: 0,
    summary: null as MirrorSummary | null,
})

function updateSummary(summary: MirrorSummary) {
    mirrorBackfillState.summary = summary
    mirrorBackfillState.currentPackName = summary.currentPackName
    mirrorBackfillState.currentPackUuid = summary.currentPackUuid
}

export async function refreshMirrorBackfillSummary() {
    if (!isSamplesDirValid()) return
    updateSummary(await mirrorSummary())
}

export async function requestStopMirrorBackfill() {
    mirrorBackfillState.stopRequested = true
    const jobId = mirrorBackfillState.summary?.jobId
    if (jobId != null) {
        updateSummary(await mirrorPauseJob(jobId))
    }
}

async function assetsNotInLibrary(assets: SampleAsset[]) {
    const missing: SampleAsset[] = []
    for (let i = 0; i < assets.length; i += SAMPLE_FLAGS_CHUNK) {
        const chunk = assets.slice(i, i + SAMPLE_FLAGS_CHUNK)
        const flags = await libraryBatchFlags(chunk.map((a) => a.uuid))
        mergeBatchFlags(flags)
        for (const asset of chunk) {
            if (!flags[asset.uuid]?.inLibrary) missing.push(asset)
        }
    }
    return missing
}

async function materializeMissing(assets: SampleAsset[]) {
    if (!assets.length) return { saved: 0, failed: 0, failures: [] as string[] }
    if (!config.samples_dir) throw new Error("Samples directory not set")
    const result = await libraryMaterializeBatch({
        samplesDir: config.samples_dir,
        concurrency: Math.min(getBulkDownloadConcurrency(), 32),
        items: assets.map((asset) => ({
            asset,
            relativeAudioPath: sampleRelativePath(asset),
        })),
    })
    if (result.failed === 0) {
        for (const asset of assets) setCachedInLibrary(asset.uuid, true)
    }
    return {
        saved: result.saved,
        failed: result.failed,
        failures: result.failures,
    }
}

async function catalogAllPacks(jobId: number) {
    mirrorBackfillState.phase = "catalog"
    let page = Math.floor((mirrorBackfillState.summary?.totalPacks ?? 0) / PACKS_PAGE_SIZE) + 1
    let totalPages = page

    while (!mirrorBackfillState.stopRequested && page <= totalPages) {
        mirrorBackfillState.catalogPage = page
        mirrorBackfillState.catalogTotalPages = totalPages
        const result = await fetchSplicePacksPage({
            page,
            limit: PACKS_PAGE_SIZE,
            tags: [],
            sort: "popularity",
            order: "DESC",
        })
        if (!result) throw new Error("Could not load Splice pack catalog")
        totalPages = result.totalPages
        mirrorBackfillState.catalogTotalPages = totalPages
        const rankOffset = (result.currentPage - 1) * PACKS_PAGE_SIZE
        updateSummary(
            await mirrorEnqueuePacks(
                jobId,
                result.items.map((pack, index) => ({
                    uuid: pack.uuid,
                    name: pack.name,
                    rank: rankOffset + index + 1,
                    listableTotal: splicePackSampleTotal(pack),
                }))
            )
        )
        void terminalLog(
            `mirror-backfill: catalog page ${page}/${totalPages} queued=${mirrorBackfillState.summary?.queuedPacks ?? 0}`,
            "info"
        )
        page += 1
    }
}

async function processPack(jobId: number) {
    const pack = await mirrorClaimNextPack(jobId)
    if (!pack) return false

    mirrorBackfillState.phase = "pack"
    mirrorBackfillState.currentPackName = pack.packName
    mirrorBackfillState.currentPackUuid = pack.packUuid
    mirrorBackfillState.currentPackListed = pack.listedCount
    mirrorBackfillState.currentPackTotal = pack.listableTotal ?? 0
    mirrorBackfillState.currentPackSaved = pack.savedCount

    let cursor = pack.cursor
    let totalRecords = pack.listableTotal ?? 0

    try {
        while (!mirrorBackfillState.stopRequested) {
            let pageResult = null as Awaited<ReturnType<typeof fetchSpliceSearchCursorPage>>
            let lastError: unknown = null
            for (let attempt = 1; attempt <= PAGE_MAX_ATTEMPTS; attempt++) {
                try {
                    pageResult = await fetchSpliceSearchCursorPage(
                        cursor,
                        BULK_DOWNLOAD_SPLICE_PAGE_SIZE,
                        packListingSort,
                        {
                            filters: fullPackFilters(),
                            parentPackUuid: pack.packUuid,
                        }
                    )
                    if (pageResult) break
                } catch (e) {
                    lastError = e
                }
                await new Promise((r) => setTimeout(r, 1200 * attempt))
            }
            if (!pageResult) {
                throw new Error(
                    lastError instanceof Error
                        ? lastError.message
                        : "Could not load pack samples"
                )
            }

            totalRecords = pageResult.totalRecords
            mirrorBackfillState.currentPackTotal = totalRecords
            const missing = await assetsNotInLibrary(pageResult.items)
            const materialized = await materializeMissing(missing)
            if (materialized.failed > 0) {
                throw new Error(
                    materialized.failures[0] ??
                        `${materialized.failed} sample(s) failed`
                )
            }

            cursor = pageResult.nextCursor
            mirrorBackfillState.currentPackListed += pageResult.items.length
            mirrorBackfillState.currentPackSaved += materialized.saved
            updateSummary(
                await mirrorCheckpointPack({
                    jobId,
                    packUuid: pack.packUuid,
                    cursor,
                    listableTotal: totalRecords,
                    listedDelta: pageResult.items.length,
                    savedDelta: materialized.saved,
                    failedDelta: materialized.failed,
                })
            )

            if (!cursor || pageResult.items.length === 0) {
                updateSummary(
                    await mirrorCompletePack({
                        jobId,
                        packUuid: pack.packUuid,
                        listableTotal: totalRecords,
                    })
                )
                void terminalLog(
                    `mirror-backfill: pack complete ${pack.packName} saved=${mirrorBackfillState.currentPackSaved}`,
                    "info"
                )
                return true
            }
        }

        updateSummary(await mirrorPauseJob(jobId))
        return false
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        updateSummary(
            await mirrorFailPack({
                jobId,
                packUuid: pack.packUuid,
                listableTotal: totalRecords || null,
                error: detail,
            })
        )
        void terminalLog(
            `mirror-backfill: pack failed ${pack.packName} (${pack.packUuid}): ${detail}`,
            "error"
        )
        return true
    }
}

export async function retryMirrorBackfillFailures() {
    const jobId = mirrorBackfillState.summary?.jobId
    if (jobId == null) return
    updateSummary(await mirrorRetryFailed(jobId))
}

export async function startMirrorBackfill() {
    if (mirrorBackfillState.running) return
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }
    const active = getActiveDownloadSessionTag()
    if (active && active !== "mirror-backfill") {
        toast("Stop the active download job before mirror backfill.", {
            variant: "info",
        })
        return
    }
    if (!tryClaimDownloadSession("mirror-backfill")) return

    mirrorBackfillState.running = true
    mirrorBackfillState.stopRequested = false

    try {
        updateSummary(
            await mirrorStartOrResume({
                filtersJson: JSON.stringify({ tags: [] }),
                sort: "pack_popularity",
            })
        )
        const jobId = mirrorBackfillState.summary?.jobId
        if (jobId == null) throw new Error("Mirror job was not created")

        await catalogAllPacks(jobId)
        while (!mirrorBackfillState.stopRequested) {
            const didWork = await processPack(jobId)
            if (!didWork) break
        }

        if (mirrorBackfillState.stopRequested) {
            updateSummary(await mirrorPauseJob(jobId))
            toast("Mirror backfill paused.", { variant: "info" })
        } else {
            updateSummary(await mirrorSummary())
            toast("Mirror backfill idle. Failed packs can be retried.", {
                variant: "info",
            })
        }
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        toast(detail, { variant: "error", durationMs: 12_000 })
        void terminalLog(`mirror-backfill: stopped: ${detail}`, "error")
    } finally {
        mirrorBackfillState.running = false
        mirrorBackfillState.phase = mirrorBackfillState.stopRequested
            ? "paused"
            : "idle"
        releaseDownloadSession("mirror-backfill")
    }
}
