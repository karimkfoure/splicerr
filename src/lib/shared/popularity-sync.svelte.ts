import {
    libraryCheckpointOfficialPopularity,
    libraryFinishOfficialPopularity,
    libraryOfficialPopularityStatus,
    libraryRestartOfficialPopularity,
    type OfficialPopularityStatus,
} from "$lib/library/api"
import { config, isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import {
    getActiveDownloadSessionTag,
    releaseDownloadSession,
    tryClaimDownloadSession,
} from "$lib/shared/download-session"
import { fetchSplicePacksPage } from "$lib/shared/store.svelte"
import { terminalLog } from "$lib/shared/terminal-log"
import { toast } from "$lib/shared/toast.svelte"

const PAGE_SIZE = 100
const MAX_ATTEMPTS = 4

export const popularitySyncState = $state({
    running: false,
    requestedPage: 0,
    status: null as OfficialPopularityStatus | null,
    error: null as string | null,
})

export async function refreshPopularitySyncStatus() {
    if (!isSamplesDirValid() || !config.samples_dir) {
        popularitySyncState.status = null
        return
    }
    popularitySyncState.status = await libraryOfficialPopularityStatus()
}

async function fetchPage(page: number) {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await fetchSplicePacksPage({
                page,
                limit: PAGE_SIZE,
                tags: [],
                sort: "popularity",
                order: "DESC",
                captureRank: false,
            })
            if (result) return result
        } catch (error) {
            lastError = error
        }
        if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) =>
                window.setTimeout(resolve, 500 * 2 ** (attempt - 1))
            )
        }
    }
    throw lastError ?? new Error("Splice returned no popularity data")
}

async function finish(reason: string) {
    popularitySyncState.status = await libraryFinishOfficialPopularity(reason)
}

export async function startPopularitySuperSync() {
    if (popularitySyncState.running) return
    if (!isSamplesDirValid() || !config.samples_dir) {
        settingsDialog.open = true
        return
    }
    const active = getActiveDownloadSessionTag()
    if (active && active !== "popularity-sync") {
        toast("Wait for the active library job to finish before syncing popularity.", {
            variant: "info",
        })
        return
    }
    if (!tryClaimDownloadSession("popularity-sync")) return

    popularitySyncState.running = true
    popularitySyncState.error = null
    try {
        popularitySyncState.status = await libraryRestartOfficialPopularity()
        let lastFingerprint: string | null = null

        while (true) {
            const status = popularitySyncState.status
            const requestedPage = status?.nextPage ?? 1
            popularitySyncState.requestedPage = requestedPage
            let result: Awaited<ReturnType<typeof fetchPage>>
            try {
                result = await fetchPage(requestedPage)
            } catch (error) {
                if ((status?.listedCount ?? 0) > 0) {
                    await finish(`endpoint_rejected_page_${requestedPage}`)
                    break
                }
                throw error
            }

            if (result.currentPage !== requestedPage) {
                await finish(`server_clamped_to_page_${result.currentPage}`)
                break
            }
            if (result.items.length === 0) {
                await finish("empty_page")
                break
            }

            const fingerprint = `${result.items[0]?.uuid}:${result.items.at(-1)?.uuid}`
            if (fingerprint === lastFingerprint) {
                await finish("repeated_page")
                break
            }
            lastFingerprint = fingerprint
            const rankOffset = status?.listedCount ?? 0
            popularitySyncState.status =
                await libraryCheckpointOfficialPopularity({
                    currentPage: result.currentPage,
                    packs: result.items.map((pack, index) => ({
                        packUuid: pack.uuid,
                        rank: rankOffset + index + 1,
                    })),
                    remoteRecords: result.totalRecords,
                    reportedPages: result.totalPages,
                    fingerprint,
                    observedAt: Date.now(),
                })
        }

        const finalStatus = popularitySyncState.status
        toast(
            `Popularity sync complete: ${finalStatus?.rankedLocalPacks ?? 0} of ${finalStatus?.totalLocalPacks ?? 0} local packs ranked.`,
            { variant: "success", durationMs: 12_000 }
        )
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        popularitySyncState.error = detail
        toast(`Popularity sync stopped: ${detail}`, {
            variant: "error",
            durationMs: 12_000,
        })
        void terminalLog(`popularity-sync: ${detail}`, "error")
    } finally {
        popularitySyncState.running = false
        popularitySyncState.requestedPage = 0
        releaseDownloadSession("popularity-sync")
    }
}
