import { querySplice, SamplesSearch } from "$lib/splice/api"
import type {
    AssetCategorySlug,
    AssetSortType,
    ChordType,
    Key,
    SampleAsset,
    SamplesSearchResponse,
    SortOrder,
    TagSummaryEntry,
} from "$lib/splice/types"
import { globalAudio } from "./audio.svelte"
import { loading } from "./loading.svelte"
import { pitchShiftAudioBuffer, semitonesFor } from "./transpose.svelte"
import { audioBufferToWav, decodeAudioFromURL } from "./wav"
import {
    libraryBatchFlags,
    librarySearch,
    type BrowseMode,
} from "$lib/library/api"
import {
    inLibraryState,
    mergeBatchFlags,
} from "$lib/library/session-cache.svelte"
import { localizeSampleAsset } from "$lib/library/localize-asset"
import { syncPackCoversForAssets } from "$lib/shared/pack-cover"
import {
    materializeSampleInLibrary,
    upsertSampleMetadataOnly,
} from "$lib/library/materialize"
import { mp3BlobUrl } from "$lib/shared/sample-bytes"
import {
    readSampleMp3Bytes,
    ensureSampleMp3OnDisk,
    syncSampleLibraryFromDisk,
} from "$lib/shared/files.svelte"
import { config, isSamplesDirValid, settingsDialog } from "./config.svelte"

export const DEFAULT_SORT = "relevance"
export const PER_PAGE = 50
/** Local SQLite search — one round-trip can safely return more than Splice API pages. */
export const LIBRARY_PER_PAGE = 2500

export const LIBRARY_SORTS = [
    "name",
    "bpm",
    "duration",
    "ingested_at",
    "key",
] as const

export const randomSeed = () =>
    Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString()

export const dataStore = $state({
    sampleAssets: [] as SampleAsset[],
    descrambledSamples: new Map<string, string>(),
    transposedSamples: new Map<string, string>(),
    tags: [] as string[],
    tag_summary: [] as TagSummaryEntry[],
    total_records: 0,
})

export const browseStore = $state({
    mode: "splice" as BrowseMode,
    libraryFavoritesOnly: false,
})

export const keys = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
] as const
export const chord_types = ["major", "minor"]

export const queryStore = $state({
    query: "",
    sort: DEFAULT_SORT as AssetSortType,
    random_seed: randomSeed(),
    order: "DESC" as SortOrder,
    page: 1,
    asset_category_slug: null as AssetCategorySlug | null,
    bpm: null as string | null,
    min_bpm: null as number | null,
    max_bpm: null as number | null,
    key: null as Key | null,
    chord_type: null as ChordType | null,
})

const queryIdentity = $derived({
    query: queryStore.query,
    sort: queryStore.sort,
    order: queryStore.order,
    random_seed: queryStore.random_seed,
    tags: dataStore.tags,
    asset_category_slug: queryStore.asset_category_slug,
    bpm: queryStore.bpm?.toString(),
    min_bpm: queryStore.min_bpm,
    max_bpm: queryStore.max_bpm,
    key: queryStore.key,
    chord_type: queryStore.chord_type,
})

export const storeCallbacks = $state({
    onbeforedataupdate: null as (() => void) | null,
    onbeforetagsupdate: null as (() => void) | null,
})

let currentQueryIdentity: string = ""

export function resetAssetList() {
    currentQueryIdentity = ""
    queryStore.page = 1
    dataStore.sampleAssets = []
    loading.fetchError = null
}

/** Sort values only valid for Splice GraphQL (not local library). */
const SPLICE_ONLY_SORTS = new Set<AssetSortType>([
    "random",
    "relevance",
    "popularity",
    "recency",
])

export function ensureSpliceCompatibleSort() {
    if (queryStore.sort === "ingested_at") {
        queryStore.sort = DEFAULT_SORT
    }
}

export function ensureLibraryCompatibleSort() {
    if (
        SPLICE_ONLY_SORTS.has(queryStore.sort) ||
        !LIBRARY_SORTS.includes(queryStore.sort as (typeof LIBRARY_SORTS)[number])
    ) {
        queryStore.sort = "ingested_at"
    }
}

function librarySortField(): string {
    const sort = queryStore.sort
    if (LIBRARY_SORTS.includes(sort as (typeof LIBRARY_SORTS)[number])) {
        return sort
    }
    return "ingested_at"
}

async function syncInLibraryFlags() {
    if (browseStore.mode !== "splice" || !isSamplesDirValid()) return
    const uuids = dataStore.sampleAssets.map((a) => a.uuid)
    if (!uuids.length) return
    try {
        const batch = await libraryBatchFlags(uuids)
        mergeBatchFlags(batch)
        for (const asset of dataStore.sampleAssets) {
            const flags = batch[asset.uuid]
            if (flags) asset.favorite = flags.favorite
        }
    } catch (e) {
        console.warn("library_batch_in_library failed", e)
    }
}

export const fetchAssets = () => {
    if (browseStore.mode === "library") {
        fetchLibraryAssets()
        return
    }
    fetchSpliceAssets()
}

function libraryQueryIdentity() {
    return JSON.stringify({
        ...queryIdentity,
        mode: "library",
        favorites: browseStore.libraryFavoritesOnly,
    })
}

function fetchLibraryAssets() {
    if (!isSamplesDirValid() || !config.samples_dir) {
        loading.assets = false
        loading.beforeFirstLoad = false
        dataStore.sampleAssets = []
        dataStore.total_records = 0
        dataStore.tag_summary = []
        loading.fetchError = null
        return
    }

    const identityBeforeFetch = libraryQueryIdentity()
    const isAppend =
        identityBeforeFetch === currentQueryIdentity && queryStore.page > 1
    if (!isAppend) {
        storeCallbacks.onbeforedataupdate?.()
        queryStore.page = 1
    }

    loading.assets = true
    loading.fetchError = null

    librarySearch({
        query: queryStore.query,
        tags: [...dataStore.tags],
        page: queryStore.page,
        limit: LIBRARY_PER_PAGE,
        sort: librarySortField(),
        order: queryStore.order,
        favoritesOnly: browseStore.libraryFavoritesOnly,
        assetCategorySlug: queryStore.asset_category_slug,
        key: queryStore.key,
        chordType: queryStore.chord_type,
        minBpm: queryStore.min_bpm,
        maxBpm: queryStore.max_bpm,
        bpm: queryStore.bpm,
        samplesDir: config.samples_dir,
    })
        .then((result) => {
            const identityAfterFetch = libraryQueryIdentity()
            if (identityBeforeFetch !== identityAfterFetch) return

            const items = result.items.map(localizeSampleAsset)
            if (isAppend) {
                dataStore.sampleAssets.push(...items)
            } else {
                dataStore.sampleAssets = items
                currentQueryIdentity = identityAfterFetch
            }
            void syncPackCoversForAssets(result.items).then(() => {
                inLibraryState.version += 1
            })
            dataStore.total_records = result.totalRecords
            storeCallbacks.onbeforetagsupdate?.()
            dataStore.tag_summary = result.tagSummary
            loading.assets = false
            loading.beforeFirstLoad = false
            loading.fetchError = null
        })
        .catch((error: Error) => {
            console.error("⚠️ Failed to fetch library assets", error)
            loading.fetchError = error
            loading.assets = false
        })
}

function fetchSpliceAssets() {
    ensureSpliceCompatibleSort()

    const identityBeforeFetch = JSON.stringify(queryIdentity)
    const isAppend = identityBeforeFetch === currentQueryIdentity
    if (!isAppend) {
        storeCallbacks.onbeforedataupdate?.()
        queryStore.page = 1
    }
    loading.assets = true
    loading.fetchError = null
    querySplice(SamplesSearch, {
        ...queryIdentity,
        page: queryStore.page,
        limit: PER_PAGE,
    })
        .then(async (response) => {
            const searchResult = (response as SamplesSearchResponse).data
                .assetsSearch
            const identityAfterFetch = JSON.stringify(queryIdentity)
            if (identityBeforeFetch == identityAfterFetch) {
                if (isAppend) {
                    dataStore.sampleAssets.push(...searchResult.items)
                    console.info("➕ Loaded more assets")
                } else {
                    for (const sampleAsset of dataStore.sampleAssets) {
                        if (
                            !searchResult.items.some(
                                (other) => sampleAsset.uuid == other.uuid
                            ) &&
                            sampleAsset.uuid != globalAudio.currentAsset?.uuid
                        ) {
                            freeDescrambledSample(sampleAsset.uuid)
                        }
                    }
                    dataStore.sampleAssets = searchResult.items
                    currentQueryIdentity = identityAfterFetch
                    console.info("🔄️ Loaded new assets")
                }
                dataStore.total_records = searchResult.response_metadata.records

                storeCallbacks.onbeforetagsupdate?.()
                dataStore.tag_summary = searchResult.tag_summary

                await syncInLibraryFlags()

                loading.assets = false
                loading.beforeFirstLoad = false

                loading.fetchError = null
            } else {
                console.info("🕜 Ignored stale assets")
            }
        })
        .catch((error: Error) => {
            console.error("⚠️ Failed to fetch assets", error)
            loading.fetchError = error
            loading.assets = false
        })
}

export class SamplesDirRequiredError extends Error {
    constructor() {
        super("Samples directory required")
        this.name = "SamplesDirRequiredError"
    }
}

const descrambledPlaybackInflight = new Map<string, Promise<string>>()
const diskPrefetchInflight = new Map<string, Promise<void>>()

/** Max in-memory descrambled MP3 blobs (~full file size each). */
const MAX_DESCRAMBLED_BLOBS = 50
const descrambledBlobLru: string[] = []

function removeDescrambledLru(uuid: string) {
    const i = descrambledBlobLru.indexOf(uuid)
    if (i >= 0) descrambledBlobLru.splice(i, 1)
}

function touchDescrambledLru(uuid: string) {
    removeDescrambledLru(uuid)
    descrambledBlobLru.push(uuid)
}

function playbackProtectedUuids(anchorUuid: string): Set<string> {
    const protectedUuids = new Set<string>([anchorUuid])
    const idx = dataStore.sampleAssets.findIndex((a) => a.uuid === anchorUuid)
    if (idx < 0) return protectedUuids
    if (idx > 0) protectedUuids.add(dataStore.sampleAssets[idx - 1].uuid)
    if (idx + 1 < dataStore.sampleAssets.length) {
        protectedUuids.add(dataStore.sampleAssets[idx + 1].uuid)
    }
    return protectedUuids
}

function trimDescrambledBlobCache(anchorUuid: string) {
    const protectedUuids = playbackProtectedUuids(anchorUuid)
    while (descrambledBlobLru.length > MAX_DESCRAMBLED_BLOBS) {
        const victim = descrambledBlobLru.find((u) => !protectedUuids.has(u))
        if (!victim) break
        freeDescrambledSample(victim)
    }
}

function registerDescrambledBlob(
    uuid: string,
    blobURL: string,
    anchorUuid: string
) {
    const existing = dataStore.descrambledSamples.get(uuid)
    if (
        existing &&
        existing !== blobURL &&
        existing.startsWith("blob:")
    ) {
        window.URL.revokeObjectURL(existing)
    }
    dataStore.descrambledSamples.set(uuid, blobURL)
    touchDescrambledLru(uuid)
    trimDescrambledBlobCache(anchorUuid)
}

export function getCachedDescrambledPlaybackUrl(
    uuid: string
): string | undefined {
    const url = dataStore.descrambledSamples.get(uuid)
    if (url) touchDescrambledLru(uuid)
    return url
}

/** Warm blob URL while the row is selected (mousedown), before play click. */
export function prefetchPlaybackUrl(sampleAsset: SampleAsset) {
    if (!isSamplesDirValid()) return
    if (semitonesFor(sampleAsset)) return
    void ensureDescrambledPlaybackUrl(sampleAsset)
    prefetchNeighborPlaybackUrls(sampleAsset)
}

function prefetchDescrambledFromDiskOnly(
    sampleAsset: SampleAsset,
    anchorUuid: string
) {
    if (!isSamplesDirValid()) return
    if (semitonesFor(sampleAsset)) return
    if (dataStore.descrambledSamples.has(sampleAsset.uuid)) return
    if (descrambledPlaybackInflight.has(sampleAsset.uuid)) return

    let inflight = diskPrefetchInflight.get(sampleAsset.uuid)
    if (inflight) return

    inflight = (async () => {
        const bytes = await readSampleMp3Bytes(sampleAsset)
        if (!bytes) return
        registerDescrambledBlob(
            sampleAsset.uuid,
            mp3BlobUrl(bytes),
            anchorUuid
        )
    })().finally(() => {
        diskPrefetchInflight.delete(sampleAsset.uuid)
    })
    diskPrefetchInflight.set(sampleAsset.uuid, inflight)
    void inflight
}

/** Prefetch list neighbors (±1) from disk only — no network, idle-scheduled. */
export function prefetchNeighborPlaybackUrls(center: SampleAsset) {
    if (!isSamplesDirValid()) return
    if (semitonesFor(center)) return

    const run = () => {
        const idx = dataStore.sampleAssets.findIndex(
            (a) => a.uuid === center.uuid
        )
        if (idx < 0) return
        for (const i of [idx - 1, idx + 1]) {
            if (i < 0 || i >= dataStore.sampleAssets.length) continue
            prefetchDescrambledFromDiskOnly(
                dataStore.sampleAssets[i],
                center.uuid
            )
        }
    }

    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 800 })
    } else {
        setTimeout(run, 50)
    }
}

function loadDescrambledPlaybackUrl(
    sampleAsset: SampleAsset
): Promise<string> {
    return (async (): Promise<string> => {
        const bytes = await readSampleMp3Bytes(sampleAsset)
        if (bytes) {
            const blobURL = mp3BlobUrl(bytes)
            registerDescrambledBlob(
                sampleAsset.uuid,
                blobURL,
                sampleAsset.uuid
            )
            scheduleDeferredLibraryTouch(sampleAsset)
            return blobURL
        }

        if (!isSamplesDirValid()) {
            throw new SamplesDirRequiredError()
        }

        loading.samples.add(sampleAsset.uuid)
        loading.samplesCount++

        try {
            const result = await materializeSampleInLibrary(sampleAsset)
            const blobURL = mp3BlobUrl(result.bytes)
            registerDescrambledBlob(
                sampleAsset.uuid,
                blobURL,
                sampleAsset.uuid
            )
            return blobURL
        } finally {
            loading.samples.delete(sampleAsset.uuid)
            loading.samplesCount--
        }
    })()
}

async function ensureDescrambledPlaybackUrl(
    sampleAsset: SampleAsset
): Promise<string> {
    const cached = dataStore.descrambledSamples.get(sampleAsset.uuid)
    if (cached) {
        touchDescrambledLru(sampleAsset.uuid)
        return cached
    }

    let inflight = descrambledPlaybackInflight.get(sampleAsset.uuid)
    if (!inflight) {
        inflight = loadDescrambledPlaybackUrl(sampleAsset)
        descrambledPlaybackInflight.set(sampleAsset.uuid, inflight)
        void inflight.finally(() => {
            descrambledPlaybackInflight.delete(sampleAsset.uuid)
        })
    }
    return inflight
}

export async function getDescrambledSampleURL(sampleAsset: SampleAsset) {
    return ensureDescrambledPlaybackUrl(sampleAsset)
}

async function upsertSampleMetadataAfterCache(
    sampleAsset: SampleAsset,
    result: {
        relativePath: string
        waveformRelativePath: string | null
    }
) {
    const { libraryUpsertFromAsset } = await import("$lib/library/api")
    await libraryUpsertFromAsset({
        asset: sampleAsset,
        relativeAudioPath: result.relativePath,
        waveformRelativePath: result.waveformRelativePath,
        audioCachedAt: Date.now(),
    })
}

function deferLibraryTouchAfterPlayback(sampleAsset: SampleAsset) {
    void (async () => {
        try {
            const synced = await syncSampleLibraryFromDisk(sampleAsset)
            if (synced) {
                await upsertSampleMetadataAfterCache(sampleAsset, synced)
                return
            }
            const result = await ensureSampleMp3OnDisk(sampleAsset)
            await upsertSampleMetadataAfterCache(sampleAsset, result)
        } catch (e) {
            console.warn("⚠️ Background library sync failed", e)
        }
    })()
}

function scheduleDeferredLibraryTouch(sampleAsset: SampleAsset) {
    const run = () => deferLibraryTouchAfterPlayback(sampleAsset)
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 3000 })
    } else {
        setTimeout(run, 0)
    }
}

export function freeDescrambledSample(uuid: string) {
    for (const key of [...dataStore.transposedSamples.keys()]) {
        if (key.startsWith(`${uuid}:`)) {
            window.URL.revokeObjectURL(dataStore.transposedSamples.get(key)!)
            dataStore.transposedSamples.delete(key)
        }
    }

    const existingBlobURL = dataStore.descrambledSamples.get(uuid)
    if (!existingBlobURL) return false

    dataStore.descrambledSamples.delete(uuid)
    removeDescrambledLru(uuid)
    descrambledPlaybackInflight.delete(uuid)
    diskPrefetchInflight.delete(uuid)
    if (existingBlobURL.startsWith("blob:")) {
        window.URL.revokeObjectURL(existingBlobURL)
    }
    console.info("⛓️‍💥 Freed descrambled sample")

    return true
}

export async function getTransposedSampleURL(
    sampleAsset: SampleAsset,
    semitones: number
) {
    const cacheKey = `${sampleAsset.uuid}:${semitones}`
    const existing = dataStore.transposedSamples.get(cacheKey)
    if (existing) {
        console.info("✔️ Reusing transposed sample blob")
        return existing
    }

    loading.samples.add(sampleAsset.uuid)
    loading.samplesCount++

    try {
        const descrambledURL = await getDescrambledSampleURL(sampleAsset)
        const buffer = await decodeAudioFromURL(descrambledURL)
        const shifted = pitchShiftAudioBuffer(buffer, semitones)
        const wav = audioBufferToWav(shifted)
        const blobURL = window.URL.createObjectURL(
            new Blob([wav], { type: "audio/wav" })
        )
        dataStore.transposedSamples.set(cacheKey, blobURL)
        console.info(`🎚️ Created transposed sample blob (${semitones} st)`)
        return blobURL
    } finally {
        loading.samples.delete(sampleAsset.uuid)
        loading.samplesCount--
    }
}

export async function getPlaybackSampleURL(sampleAsset: SampleAsset) {
    const semitones = semitonesFor(sampleAsset)
    if (!semitones) return ensureDescrambledPlaybackUrl(sampleAsset)
    return await getTransposedSampleURL(sampleAsset, semitones)
}

export function clearTransposedCache() {
    for (const url of dataStore.transposedSamples.values()) {
        window.URL.revokeObjectURL(url)
    }
    dataStore.transposedSamples.clear()
    console.info("🧹 Cleared transposed sample cache")
}

export async function queueFavoriteMaterialization(sampleAsset: SampleAsset) {
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }
    await upsertSampleMetadataOnly(sampleAsset, true)
    try {
        await materializeSampleInLibrary(sampleAsset)
    } catch (e) {
        console.error("Favorite materialization failed", e)
    }
}
