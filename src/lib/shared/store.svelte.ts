import {
    querySplice,
    PacksSearch,
    SamplesSearch,
    SamplesSearchCursor,
} from "$lib/splice/api"
import type {
    AssetCategorySlug,
    AssetSortType,
    ChordType,
    Key,
    PackAsset,
    PacksSearchResponse,
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
    libraryCount,
    librarySearch,
    type BrowseMode,
} from "$lib/library/api"
import { mergeBatchFlags } from "$lib/library/session-cache.svelte"
import { localizeSampleAsset } from "$lib/library/localize-asset"
import { materializeSampleInLibrary } from "$lib/library/materialize"
import { mp3BlobUrl } from "$lib/shared/sample-bytes"
import {
    readSampleMp3Bytes,
    ensureSampleMp3OnDisk,
    syncSampleLibraryFromDisk,
} from "$lib/shared/files.svelte"
import { config, isSamplesDirValid, settingsDialog } from "./config.svelte"
import {
    DEFAULT_MP3_START_TRIM_SAMPLES,
    mp3StartTrimSeconds,
} from "$lib/shared/mp3-padding"
import {
    buildPackPopularityScopeKey,
    capturePackRankPage,
} from "$lib/splice/pack-popularity"

export const DEFAULT_SORT = "relevance"
export const PER_PAGE = 50
/** Splice page size while walking full result sets in bulk download. */
export const BULK_DOWNLOAD_SPLICE_PAGE_SIZE = 100
/** Local SQLite search — one round-trip can safely return more than Splice API pages. */
export const LIBRARY_PER_PAGE = 100

export const LIBRARY_SORTS = [
    "name",
    "pack_name",
    "pack_popularity",
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
    total_exact: true,
    total_counting: false,
    has_more: false,
})

export const browseStore = $state({
    mode: "splice" as BrowseMode,
    libraryFavoritesOnly: false,
})

type BrowseListCache = {
    identity: string
    sampleAssets: SampleAsset[]
    total_records: number
    total_exact: boolean
    has_more: boolean
    tag_summary: TagSummaryEntry[]
    page: number
    nextCursor: string | null
}

const browseListCaches: Record<BrowseMode, BrowseListCache | null> = {
    splice: null,
    library: null,
}

function browseQueryIdentity(mode: BrowseMode) {
    if (mode === "library") {
        return JSON.stringify({
            ...queryIdentity,
            mode: "library",
            favorites: browseStore.libraryFavoritesOnly,
        })
    }
    return JSON.stringify({ ...queryIdentity, mode: "splice" })
}

function spliceQueryIdentity() {
    return browseQueryIdentity("splice")
}

function snapshotBrowseListCache(mode: BrowseMode) {
    if (dataStore.sampleAssets.length === 0) return
    browseListCaches[mode] = {
        identity: browseQueryIdentity(mode),
        sampleAssets: dataStore.sampleAssets.slice(),
        total_records: dataStore.total_records,
        total_exact: dataStore.total_exact,
        has_more: dataStore.has_more,
        tag_summary: dataStore.tag_summary,
        page: queryStore.page,
        nextCursor: mode === "library" ? libraryNextCursor : null,
    }
}

export function resetSortForBrowseMode(mode: BrowseMode) {
    queryStore.order = "DESC"
    queryStore.sort = mode === "library" ? "ingested_at" : DEFAULT_SORT
    queryStore.pack_uuid = null
    queryStore.pack_label = null
    queryStore.pack_folder_name = null
}

/** Switch Splice ↔ My library without flashing an empty list when filters match. */
export function switchBrowseMode(mode: BrowseMode) {
    alignListAfterBrowseModeSwitch = true
    snapshotBrowseListCache(browseStore.mode)
    browseStore.mode = mode
    resetSortForBrowseMode(mode)

    const identity = browseQueryIdentity(mode)
    const cache = browseListCaches[mode]
    if (cache?.identity === identity && cache.sampleAssets.length > 0) {
        dataStore.sampleAssets = cache.sampleAssets
        dataStore.total_records = cache.total_records
        dataStore.total_exact = cache.total_exact
        dataStore.has_more = cache.has_more
        dataStore.tag_summary = cache.tag_summary
        currentQueryIdentity = identity
        queryStore.page = cache.page
        if (mode === "library") libraryNextCursor = cache.nextCursor
        loading.assets = false
        loading.fetchError = null
        loading.beforeFirstLoad = false
        applyBrowseModeListReset()
        return
    }

    resetAssetList()
    fetchAssets()
}

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
    pack_uuid: null as string | null,
    pack_label: null as string | null,
    /** Full pack folder name (library disk paths / cover lookup). */
    pack_folder_name: null as string | null,
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
    pack_uuid: queryStore.pack_uuid,
})

export const storeCallbacks = $state({
    onbeforedataupdate: null as (() => void) | null,
    onbeforetagsupdate: null as (() => void) | null,
    /** Scroll list to top and focus first row after Splice ↔ library tab change. */
    onBrowseModeListReset: null as (() => void) | null,
})

let currentQueryIdentity: string = ""
let alignListAfterBrowseModeSwitch = false
let libraryRequestId = 0
let libraryCountRequestId = 0
let libraryNextCursor: string | null = null
let libraryAppendInFlight = false

function applyBrowseModeListReset() {
    if (!alignListAfterBrowseModeSwitch) return
    alignListAfterBrowseModeSwitch = false
    storeCallbacks.onBrowseModeListReset?.()
}

export function resetAssetList() {
    libraryRequestId += 1
    libraryCountRequestId += 1
    currentQueryIdentity = ""
    queryStore.page = 1
    libraryNextCursor = null
    libraryAppendInFlight = false
    dataStore.sampleAssets = []
    dataStore.total_counting = false
    loading.fetchError = null
}

export function packDisplayName(fullName: string) {
    return fullName.split("/").slice(-1)[0] || fullName
}

/** Set pack filter from a row’s parent pack and reload results. */
export function applyPackFilter(pack: PackAsset) {
    queryStore.pack_uuid = pack.uuid
    queryStore.pack_label = packDisplayName(pack.name)
    queryStore.pack_folder_name = pack.name
    resetAssetList()
    fetchAssets()
}

/** Sort values only valid for Splice GraphQL (not local library). */
const SPLICE_ONLY_SORTS = new Set<AssetSortType>([
    "random",
    "relevance",
    "popularity",
    "recency",
])

const LIBRARY_ONLY_SORTS = new Set<AssetSortType>([
    "ingested_at",
    "pack_name",
    "pack_popularity",
])

export function ensureSpliceCompatibleSort() {
    if (LIBRARY_ONLY_SORTS.has(queryStore.sort)) {
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
        dataStore.total_exact = true
        dataStore.has_more = false
        dataStore.tag_summary = []
        loading.fetchError = null
        return
    }

    const identityBeforeFetch = libraryQueryIdentity()
    const isAppend =
        identityBeforeFetch === currentQueryIdentity && libraryNextCursor !== null
    if (isAppend && libraryAppendInFlight) return
    if (!isAppend) {
        storeCallbacks.onbeforedataupdate?.()
        queryStore.page = 1
    }

    loading.assets = true
    loading.fetchError = null
    const requestId = ++libraryRequestId
    const countRequestId = isAppend ? libraryCountRequestId : ++libraryCountRequestId
    if (isAppend) libraryAppendInFlight = true

    librarySearch({
        query: queryStore.query,
        tags: [...dataStore.tags],
        cursor: isAppend ? libraryNextCursor : null,
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
        packUuid: queryStore.pack_uuid,
        samplesDir: config.samples_dir,
    })
        .then((result) => {
            if (requestId !== libraryRequestId) return
            libraryAppendInFlight = false
            loading.assets = false
            loading.beforeFirstLoad = false
            if (browseStore.mode !== "library") {
                alignListAfterBrowseModeSwitch = false
                return
            }

            const identityAfterFetch = libraryQueryIdentity()
            if (identityBeforeFetch !== identityAfterFetch) {
                alignListAfterBrowseModeSwitch = false
                return
            }

            const items = result.items.map(localizeSampleAsset)
            if (isAppend) {
                dataStore.sampleAssets.push(...items)
            } else {
                dataStore.sampleAssets = items
                currentQueryIdentity = identityAfterFetch
            }
            dataStore.total_records = result.totalRecords
            dataStore.total_exact = result.totalExact
            dataStore.has_more = result.hasMore
            libraryNextCursor = result.nextCursor
            storeCallbacks.onbeforetagsupdate?.()
            dataStore.tag_summary = result.tagSummary
            loading.fetchError = null
            applyBrowseModeListReset()
            if (!isAppend && !result.totalExact) {
                dataStore.total_counting = true
                libraryCount({
                    query: queryStore.query,
                    tags: [...dataStore.tags],
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
                    packUuid: queryStore.pack_uuid,
                    samplesDir: config.samples_dir!,
                })
                    .then((total) => {
                        if (
                            countRequestId !== libraryCountRequestId ||
                            identityBeforeFetch !== libraryQueryIdentity()
                        ) return
                        dataStore.total_records = total
                        dataStore.total_exact = true
                    })
                    .catch((error) => {
                        console.warn("library_count failed", error)
                    })
                    .finally(() => {
                        if (countRequestId === libraryCountRequestId) {
                            dataStore.total_counting = false
                        }
                    })
            }
        })
        .catch((error: Error) => {
            if (requestId !== libraryRequestId) return
            libraryAppendInFlight = false
            console.error("⚠️ Failed to fetch library assets", error)
            loading.fetchError = error
            loading.assets = false
        })
}

function fetchSpliceAssets() {
    ensureSpliceCompatibleSort()

    const identityBeforeFetch = spliceQueryIdentity()
    const isAppend =
        identityBeforeFetch === currentQueryIdentity && queryStore.page > 1
    if (!isAppend) {
        storeCallbacks.onbeforedataupdate?.()
        queryStore.page = 1
    }
    loading.assets = true
    loading.fetchError = null
    querySplice(SamplesSearch, {
        ...queryIdentity,
        parent_asset_uuid: queryStore.pack_uuid,
        page: queryStore.page,
        limit: PER_PAGE,
    })
        .then((response) => {
            loading.assets = false
            loading.beforeFirstLoad = false

            if (browseStore.mode !== "splice") {
                alignListAfterBrowseModeSwitch = false
                return
            }

            const identityAfterFetch = spliceQueryIdentity()
            if (identityBeforeFetch !== identityAfterFetch) {
                console.info("🕜 Ignored stale assets")
                alignListAfterBrowseModeSwitch = false
                return
            }

            const searchResult = (response as SamplesSearchResponse | null)?.data
                ?.assetsSearch
            if (!searchResult) {
                loading.fetchError = new Error("Splice search failed")
                return
            }

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
            dataStore.total_exact = true
            dataStore.has_more =
                dataStore.sampleAssets.length < dataStore.total_records

            storeCallbacks.onbeforetagsupdate?.()
            dataStore.tag_summary = searchResult.tag_summary
            loading.fetchError = null
            applyBrowseModeListReset()

            void syncInLibraryFlags()
        })
        .catch((error: Error) => {
            console.error("⚠️ Failed to fetch assets", error)
            loading.fetchError = error
            loading.assets = false
        })
}

export function getSpliceQueryIdentity() {
    return spliceQueryIdentity()
}

/** Filters for Splice sample search, frozen for bulk jobs. */
export type SpliceSearchFilters = {
    query: string
    tags: string[]
    asset_category_slug: AssetCategorySlug | null
    bpm: string | null
    min_bpm: number | null
    max_bpm: number | null
    key: Key | null
    chord_type: ChordType | null
    pack_uuid: string | null
}

export function captureSpliceSearchFilters(): SpliceSearchFilters {
    return {
        query: queryStore.query,
        tags: [...dataStore.tags],
        asset_category_slug: queryStore.asset_category_slug,
        bpm: queryStore.bpm?.toString() ?? null,
        min_bpm: queryStore.min_bpm,
        max_bpm: queryStore.max_bpm,
        key: queryStore.key,
        chord_type: queryStore.chord_type,
        pack_uuid: queryStore.pack_uuid,
    }
}

function spliceSearchVariables(
    filters: SpliceSearchFilters,
    parentPackUuid?: string | null
) {
    return {
        query: filters.query.trim() || null,
        tags: filters.tags,
        asset_category_slug: filters.asset_category_slug,
        bpm: filters.bpm,
        min_bpm: filters.min_bpm,
        max_bpm: filters.max_bpm,
        key: filters.key,
        chord_type: filters.chord_type,
        ac_uuid: null as string | null,
        parent_asset_uuid: parentPackUuid ?? filters.pack_uuid,
        ...(parentPackUuid != null || filters.pack_uuid
            ? { parent_asset_type: "pack" as const }
            : {}),
    }
}

const PACKS_LIST_PAGE_SIZE = 50

/** Paginated pack search (popularity sort by default). */
export async function fetchSplicePacksPage(options: {
    page: number
    limit?: number
    tags: string[]
    query?: string | null
    sort?: AssetSortType
    order?: SortOrder
}) {
    const response = await querySplice(PacksSearch, {
        page: options.page,
        limit: options.limit ?? PACKS_LIST_PAGE_SIZE,
        tags: options.tags,
        query: options.query?.trim() || null,
        sort: options.sort ?? "popularity",
        order: options.order ?? "DESC",
        random_seed: null,
    })
    const searchResult = (response as PacksSearchResponse | null)?.data
        ?.assetsSearch
    if (!searchResult) return null
    const limit = options.limit ?? PACKS_LIST_PAGE_SIZE
    const currentPage = searchResult.pagination_metadata.currentPage
    if ((options.sort ?? "popularity") === "popularity") {
        capturePackRankPage(
            buildPackPopularityScopeKey(options.tags),
            searchResult.items,
            currentPage,
            limit
        )
    }
    return {
        items: searchResult.items,
        totalRecords: searchResult.response_metadata.records,
        currentPage,
        totalPages: searchResult.pagination_metadata.totalPages,
    }
}

/** One Splice search page for the current filters (used by bulk download). */
export async function fetchSpliceSearchPage(
    page: number,
    limit = PER_PAGE
) {
    ensureSpliceCompatibleSort()
    const response = await querySplice(SamplesSearch, {
        ...queryIdentity,
        parent_asset_uuid: queryStore.pack_uuid,
        page,
        limit,
    })
    const searchResult = (response as SamplesSearchResponse | null)?.data
        ?.assetsSearch
    if (!searchResult) return null
    return {
        items: searchResult.items,
        totalRecords: searchResult.response_metadata.records,
        currentPage: searchResult.pagination_metadata.currentPage,
        totalPages: searchResult.pagination_metadata.totalPages,
    }
}

/** Sort params frozen when a bulk download starts (matches the visible list). */
export type BulkSpliceListingSort = {
    sort: AssetSortType
    order: SortOrder
    random_seed: string | null
}

export function captureBulkSpliceListingSort(): BulkSpliceListingSort {
    return {
        sort: queryStore.sort,
        order: queryStore.order,
        random_seed: queryStore.random_seed,
    }
}

/**
 * Cursor-based Splice search page (bulk download listing).
 * Pass `listingSort` from {@link captureBulkSpliceListingSort} at job start.
 */
export async function fetchSpliceSearchCursorPage(
    cursor: string | null,
    limit = PER_PAGE,
    listingSort?: BulkSpliceListingSort,
    searchContext?: {
        filters?: SpliceSearchFilters
        /** When set, lists samples inside this pack (overrides pack filter). */
        parentPackUuid?: string | null
    }
) {
    ensureSpliceCompatibleSort()
    const sort = listingSort?.sort ?? queryStore.sort
    const order = listingSort?.order ?? queryStore.order
    const random_seed =
        listingSort?.random_seed ?? queryStore.random_seed
    const filters = searchContext?.filters ?? captureSpliceSearchFilters()
    const response = await querySplice(SamplesSearchCursor, {
        ...spliceSearchVariables(filters, searchContext?.parentPackUuid),
        sort,
        order,
        random_seed,
        cursor,
        limit,
    })
    const searchResult = (response as SamplesSearchResponse | null)?.data
        ?.assetsSearch
    if (!searchResult) return null
    const nextCursor = searchResult.response_metadata.next ?? null
    return {
        items: searchResult.items,
        totalRecords: searchResult.response_metadata.records,
        nextCursor,
    }
}

export class SamplesDirRequiredError extends Error {
    constructor() {
        super("Samples directory required")
        this.name = "SamplesDirRequiredError"
    }
}

const descrambledPlaybackInflight = new Map<string, Promise<string>>()
const diskPrefetchInflight = new Map<string, Promise<void>>()
const playbackTrimSeconds = new Map<string, number>()

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
    anchorUuid: string,
    bytes: Uint8Array
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
    playbackTrimSeconds.set(uuid, mp3StartTrimSeconds(bytes))
    touchDescrambledLru(uuid)
    trimDescrambledBlobCache(anchorUuid)
}

export function getPlaybackTrimSeconds(uuid: string): number {
    return playbackTrimSeconds.get(uuid) ?? DEFAULT_MP3_START_TRIM_SAMPLES / 44_100
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
            anchorUuid,
            bytes
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
                sampleAsset.uuid,
                bytes
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
                sampleAsset.uuid,
                result.bytes
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
    playbackTrimSeconds.delete(uuid)
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
