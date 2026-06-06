import type { SampleAsset } from "$lib/splice/types"
import { libraryBatchFlags } from "$lib/library/api"
import { materializeSampleInLibrary } from "$lib/library/materialize"
import {
    getCachedInLibrary,
    mergeBatchFlags,
} from "$lib/library/session-cache.svelte"
import { savePackImage } from "$lib/shared/files.svelte"
import { isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import {
    browseStore,
    fetchSpliceSearchPage,
    getSpliceQueryIdentity,
    PER_PAGE,
} from "$lib/shared/store.svelte"

const DOWNLOAD_CONCURRENCY = 20
const LIBRARY_FLAGS_CHUNK = 200

export const bulkDownloadState = $state({
    running: false,
    phase: "idle" as "idle" | "listing" | "downloading",
    /** Samples fetched from Splice while walking pages */
    listed: 0,
    /** Targets after skipping in-library */
    total: 0,
    completed: 0,
    failed: 0,
})

async function assetsNotInLibrary(
    assets: SampleAsset[]
): Promise<SampleAsset[]> {
    const out: SampleAsset[] = []
    for (let i = 0; i < assets.length; i += LIBRARY_FLAGS_CHUNK) {
        const chunk = assets.slice(i, i + LIBRARY_FLAGS_CHUNK)
        const batch = await libraryBatchFlags(chunk.map((a) => a.uuid))
        mergeBatchFlags(batch)
        for (const asset of chunk) {
            const flags = batch[asset.uuid]
            const inLibrary =
                flags?.inLibrary ?? getCachedInLibrary(asset.uuid)
            if (!inLibrary) out.push(asset)
        }
    }
    return out
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

export async function downloadAllSpliceResults() {
    if (bulkDownloadState.running) return
    if (browseStore.mode !== "splice") return
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }

    const searchIdentity = getSpliceQueryIdentity()
    bulkDownloadState.running = true
    bulkDownloadState.phase = "listing"
    bulkDownloadState.listed = 0
    bulkDownloadState.total = 0
    bulkDownloadState.completed = 0
    bulkDownloadState.failed = 0

    try {
        const all: SampleAsset[] = []
        let page = 1
        let totalRecords = Number.POSITIVE_INFINITY

        while (all.length < totalRecords) {
            if (getSpliceQueryIdentity() !== searchIdentity) {
                console.info("Bulk download stopped: search changed")
                return
            }

            const pageResult = await fetchSpliceSearchPage(page)
            if (!pageResult?.items.length) break

            totalRecords = pageResult.totalRecords
            all.push(...pageResult.items)
            bulkDownloadState.listed = all.length

            if (pageResult.items.length < PER_PAGE) break
            page++
        }

        const toDownload = await assetsNotInLibrary(all)
        bulkDownloadState.phase = "downloading"
        bulkDownloadState.total = toDownload.length

        if (!toDownload.length) return

        await runPool(toDownload, DOWNLOAD_CONCURRENCY, async (asset) => {
            if (getSpliceQueryIdentity() !== searchIdentity) return

            try {
                await materializeSampleInLibrary(asset)
                await savePackImage(asset)
            } catch (e) {
                console.error("Bulk download failed", asset.name, e)
                bulkDownloadState.failed++
            } finally {
                bulkDownloadState.completed++
            }
        })
    } finally {
        bulkDownloadState.running = false
        bulkDownloadState.phase = "idle"
    }
}
