import { invoke } from "@tauri-apps/api/core"
import type {
    SampleAsset,
    SamplesSearchResponse,
    TagSummaryEntry,
} from "$lib/splice/types"

export type BrowseMode = "splice" | "library"

export async function libraryOpen(samplesDir: string) {
    return invoke<void>("library_open", { samplesDir })
}

export async function libraryClose() {
    return invoke<void>("library_close")
}

export type UpsertPayload = {
    asset: SampleAsset
    relativeAudioPath: string
    waveformRelativePath?: string | null
    audioCachedAt: number
    favorite?: boolean
}

export async function libraryUpsertFromAsset(payload: UpsertPayload) {
    return invoke<void>("library_upsert_from_asset", {
        payload: {
            asset: payload.asset,
            relativeAudioPath: payload.relativeAudioPath,
            waveformRelativePath: payload.waveformRelativePath ?? null,
            audioCachedAt: payload.audioCachedAt,
            favorite: payload.favorite ?? null,
        },
    })
}

export type MaterializeBatchItem = {
    asset: SampleAsset
    relativeAudioPath: string
}

export type MaterializeBatchResult = {
    saved: number
    alreadyCached: number
    failed: number
    failures: string[]
}

export async function libraryMaterializeBatch(params: {
    samplesDir: string
    items: MaterializeBatchItem[]
    concurrency: number
}) {
    return invoke<MaterializeBatchResult>("library_materialize_batch", params)
}

export type ExportSampleWavResult = {
    absolutePath: string
    relativePath: string
    sampleRate: number
    channels: number
    sourceFrames: number
    outputFrames: number
    startTrimSamples: number
    endTrimSamples: number
    targetBeats: number | null
    gridConfident: boolean
    policyVersion: number
    correctionEnabled: boolean
}

export async function exportSampleWav(params: {
    samplesDir: string
    relativeAudioPath: string
    assetCategorySlug: string
    durationMs: number
    bpm?: number | null
    correctionEnabled: boolean
}) {
    return invoke<ExportSampleWavResult>("export_sample_wav", {
        params: {
            samplesDir: params.samplesDir,
            relativeAudioPath: params.relativeAudioPath,
            assetCategorySlug: params.assetCategorySlug,
            durationMs: params.durationMs,
            bpm: params.bpm ?? null,
            correctionEnabled: params.correctionEnabled,
        },
    })
}

export type FavoriteExportSummary = {
    exported: number
    alreadyExported: number
    failed: number
    failures: string[]
}

export async function exportMissingFavoriteWavs(samplesDir: string) {
    return invoke<FavoriteExportSummary>("export_missing_favorite_wavs", {
        samplesDir,
    })
}

export type LibrarySampleFlags = {
    inLibrary: boolean
    favorite: boolean
}

export async function libraryBatchFlags(uuids: string[]) {
    return invoke<Record<string, LibrarySampleFlags>>("library_batch_flags", {
        uuids,
    })
}

export async function librarySetFavorite(
    uuid: string,
    favorite: boolean,
    asset?: SampleAsset,
    relativeAudioPath?: string
) {
    return invoke<void>("library_set_favorite", {
        uuid,
        favorite,
        asset: asset ?? null,
        relativeAudioPath: relativeAudioPath ?? null,
    })
}

export type LibrarySearchParams = {
    query?: string
    tags: string[]
    cursor?: string | null
    limit: number
    sort: string
    order: string
    favoritesOnly: boolean
    assetCategorySlug?: string | null
    key?: string | null
    chordType?: string | null
    minBpm?: number | null
    maxBpm?: number | null
    bpm?: string | null
    packUuid?: string | null
    samplesDir: string
}

export type LibraryPackListEntry = {
    uuid: string
    name: string
    coverRelativePath: string | null
}

export async function libraryListPacks(samplesDir: string, query?: string) {
    return invoke<LibraryPackListEntry[]>("library_list_packs", {
        params: {
            samplesDir,
            query: query?.trim() || null,
        },
    })
}

export type PackMirrorStats = {
    cached: number
    listableTotal: number | null
}

export async function libraryPackMirrorStats(packUuids: string[]) {
    if (!packUuids.length) return {} as Record<string, PackMirrorStats>
    return invoke<Record<string, PackMirrorStats>>(
        "library_pack_mirror_stats",
        { packUuids }
    )
}

export async function librarySetPackListableTotal(
    packUuid: string,
    total: number
) {
    return invoke<void>("library_set_pack_listable_total", {
        packUuid,
        total,
    })
}

export async function libraryPackCachedCounts(packUuids: string[]) {
    if (!packUuids.length) return {} as Record<string, number>
    const stats = await libraryPackMirrorStats(packUuids)
    return Object.fromEntries(
        Object.entries(stats).map(([uuid, s]) => [uuid, s.cached])
    )
}

export type PackRankObservation = {
    packUuid: string
    packName?: string | null
    rank: number
    observedAt: number
    source?: string | null
}

export async function recordPackRankObservations(params: {
    scopeKey: string
    observations: PackRankObservation[]
}) {
    if (!params.observations.length) return
    return invoke<void>("library_record_pack_ranks", {
        params: {
            scopeKey: params.scopeKey,
            observations: params.observations.map((o) => ({
                packUuid: o.packUuid,
                packName: o.packName ?? null,
                rank: o.rank,
                observedAt: o.observedAt,
                source: o.source ?? null,
            })),
        },
    })
}

export type PackPopularityScoreRow = {
    score: number
    bestRank: number | null
    observationCount: number
    updatedAt: number
}

export async function libraryPackPopularityScores(
    scopeKey: string,
    packUuids?: string[]
) {
    return invoke<Record<string, PackPopularityScoreRow>>(
        "library_pack_popularity_scores",
        {
            params: {
                scopeKey,
                packUuids: packUuids?.length ? packUuids : null,
            },
        }
    )
}

export type MirrorSummary = {
    jobId: number | null
    status: "idle" | "running" | "paused" | "complete"
    totalPacks: number
    queuedPacks: number
    runningPacks: number
    completedPacks: number
    failedPacks: number
    totalSamples: number
    cachedSamples: number
    sessionSaved: number
    currentPackUuid: string | null
    currentPackName: string | null
    lastError: string | null
    updatedAt: number | null
}

export type MirrorPackRow = {
    jobId: number
    packUuid: string
    packName: string
    rank: number
    status: string
    cursor: string | null
    listableTotal: number | null
    cachedCount: number
    listedCount: number
    savedCount: number
    failedCount: number
    attempts: number
    lastError: string | null
}

export type MirrorPackInput = {
    uuid: string
    name: string
    rank: number
    listableTotal?: number | null
}

export async function mirrorStartOrResume(params: {
    filtersJson: string
    sort: string
}) {
    return invoke<MirrorSummary>("mirror_start_or_resume", { params })
}

export async function mirrorSummary() {
    return invoke<MirrorSummary>("mirror_summary")
}

export async function mirrorEnqueuePacks(
    jobId: number,
    packs: MirrorPackInput[]
) {
    return invoke<MirrorSummary>("mirror_enqueue_packs", { jobId, packs })
}

export async function mirrorClaimNextPack(jobId: number) {
    return invoke<MirrorPackRow | null>("mirror_claim_next_pack", { jobId })
}

export async function mirrorCheckpointPack(params: {
    jobId: number
    packUuid: string
    cursor?: string | null
    listableTotal?: number | null
    listedDelta: number
    savedDelta: number
    failedDelta: number
}) {
    return invoke<MirrorSummary>("mirror_checkpoint_pack", { params })
}

export async function mirrorCompletePack(params: {
    jobId: number
    packUuid: string
    listableTotal?: number | null
    error?: string | null
}) {
    return invoke<MirrorSummary>("mirror_complete_pack", { params })
}

export async function mirrorFailPack(params: {
    jobId: number
    packUuid: string
    listableTotal?: number | null
    error?: string | null
}) {
    return invoke<MirrorSummary>("mirror_fail_pack", { params })
}

export async function mirrorPauseJob(jobId: number) {
    return invoke<MirrorSummary>("mirror_pause_job", { jobId })
}

export async function mirrorRetryFailed(jobId: number) {
    return invoke<MirrorSummary>("mirror_retry_failed", { jobId })
}

export type LibrarySearchResponse = {
    items: SampleAsset[]
    totalRecords: number
    totalExact: boolean
    hasMore: boolean
    nextCursor: string | null
    tagSummary: TagSummaryEntry[]
}

export async function librarySearch(params: LibrarySearchParams) {
    const res = await invoke<{
        items: SampleAsset[]
        totalRecords: number
        totalExact: boolean
        hasMore: boolean
        nextCursor: string | null
        tagSummary: TagSummaryEntry[]
    }>("library_search", {
        params: {
            query: params.query ?? null,
            tags: params.tags,
            cursor: params.cursor ?? null,
            limit: params.limit,
            sort: params.sort,
            order: params.order,
            favoritesOnly: params.favoritesOnly,
            assetCategorySlug: params.assetCategorySlug ?? null,
            key: params.key ?? null,
            chordType: params.chordType ?? null,
            minBpm: params.minBpm ?? null,
            maxBpm: params.maxBpm ?? null,
            bpm: params.bpm ?? null,
            packUuid: params.packUuid ?? null,
            samplesDir: params.samplesDir,
        },
    })
    return {
        items: res.items,
        totalRecords: res.totalRecords,
        totalExact: res.totalExact,
        hasMore: res.hasMore,
        nextCursor: res.nextCursor,
        tagSummary: res.tagSummary,
    } satisfies LibrarySearchResponse
}

export async function libraryCount(params: LibrarySearchParams) {
    return invoke<number>("library_count", {
        params: {
            query: params.query ?? null,
            tags: params.tags,
            cursor: null,
            limit: params.limit,
            sort: params.sort,
            order: params.order,
            favoritesOnly: params.favoritesOnly,
            assetCategorySlug: params.assetCategorySlug ?? null,
            key: params.key ?? null,
            chordType: params.chordType ?? null,
            minBpm: params.minBpm ?? null,
            maxBpm: params.maxBpm ?? null,
            bpm: params.bpm ?? null,
            packUuid: params.packUuid ?? null,
            samplesDir: params.samplesDir,
        },
    })
}

export async function libraryTagSummary(params: LibrarySearchParams) {
    return invoke<TagSummaryEntry[]>("library_tag_summary", {
        params: {
            query: params.query ?? null,
            tags: params.tags,
            cursor: params.cursor ?? null,
            limit: params.limit,
            sort: params.sort,
            order: params.order,
            favoritesOnly: params.favoritesOnly,
            assetCategorySlug: params.assetCategorySlug ?? null,
            key: params.key ?? null,
            chordType: params.chordType ?? null,
            minBpm: params.minBpm ?? null,
            maxBpm: params.maxBpm ?? null,
            bpm: params.bpm ?? null,
            packUuid: params.packUuid ?? null,
            samplesDir: params.samplesDir,
        },
    })
}
