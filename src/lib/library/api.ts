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
    page: number
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

export type LibrarySearchResponse = {
    items: SampleAsset[]
    totalRecords: number
    tagSummary: TagSummaryEntry[]
}

export async function librarySearch(params: LibrarySearchParams) {
    const res = await invoke<{
        items: SampleAsset[]
        totalRecords: number
        tagSummary: TagSummaryEntry[]
    }>("library_search", {
        params: {
            query: params.query ?? null,
            tags: params.tags,
            page: params.page,
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
        tagSummary: res.tagSummary,
    } satisfies LibrarySearchResponse
}

export async function libraryTagSummary(params: LibrarySearchParams) {
    return invoke<TagSummaryEntry[]>("library_tag_summary", {
        params: {
            query: params.query ?? null,
            tags: params.tags,
            page: params.page,
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
