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
} from "$lib/shared/files.svelte"
import { config, isSamplesDirValid, settingsDialog } from "./config.svelte"

export const DEFAULT_SORT = "relevance"
export const PER_PAGE = 50

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
    const isAppend = identityBeforeFetch === currentQueryIdentity
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
        limit: PER_PAGE,
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

export async function getDescrambledSampleURL(sampleAsset: SampleAsset) {
    const existingBlobURL = dataStore.descrambledSamples.get(sampleAsset.uuid)
    if (existingBlobURL) {
        console.info("✔️ Reusing descrambled sample blob")
        return existingBlobURL
    }

    if (!isSamplesDirValid()) {
        throw new SamplesDirRequiredError()
    }

    loading.samples.add(sampleAsset.uuid)
    loading.samplesCount++

    try {
        const onDisk = await readSampleMp3Bytes(sampleAsset)
        let blobURL: string

        if (onDisk) {
            blobURL = mp3BlobUrl(onDisk)
            const result = await ensureSampleMp3OnDisk(sampleAsset)
            await upsertSampleMetadataAfterCache(sampleAsset, result)
        } else {
            const result = await materializeSampleInLibrary(sampleAsset)
            blobURL = mp3BlobUrl(result.bytes)
        }

        dataStore.descrambledSamples.set(sampleAsset.uuid, blobURL)
        console.info("🔗 Created descrambled sample blob")
        return blobURL
    } finally {
        loading.samples.delete(sampleAsset.uuid)
        loading.samplesCount--
    }
}

async function upsertSampleMetadataAfterCache(
    sampleAsset: SampleAsset,
    result: Awaited<ReturnType<typeof ensureSampleMp3OnDisk>>
) {
    const { libraryUpsertFromAsset } = await import("$lib/library/api")
    await libraryUpsertFromAsset({
        asset: sampleAsset,
        relativeAudioPath: result.relativePath,
        waveformRelativePath: result.waveformRelativePath,
        audioCachedAt: Date.now(),
    })
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
    window.URL.revokeObjectURL(existingBlobURL)
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
    if (!semitones) return await getDescrambledSampleURL(sampleAsset)
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
