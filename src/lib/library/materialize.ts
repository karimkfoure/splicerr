import type { SampleAsset } from "$lib/splice/types"
import {
    ensureSampleMp3OnDisk,
    sampleRelativePath,
} from "$lib/shared/files.svelte"
import { libraryUpsertFromAsset } from "./api"
import { setCachedInLibrary } from "./session-cache.svelte"
import { withLibraryUpsertLimit } from "./upsert-limit"

async function upsertMaterializedSample(
    sampleAsset: SampleAsset,
    result: Awaited<ReturnType<typeof ensureSampleMp3OnDisk>>
) {
    const now = Date.now()
    await withLibraryUpsertLimit(() =>
        libraryUpsertFromAsset({
            asset: sampleAsset,
            relativeAudioPath: result.relativePath,
            waveformRelativePath: result.waveformRelativePath,
            audioCachedAt: now,
        })
    )
    setCachedInLibrary(sampleAsset.uuid, true)
}

export async function materializeSampleInLibrary(sampleAsset: SampleAsset) {
    const result = await ensureSampleMp3OnDisk(sampleAsset)
    await upsertMaterializedSample(sampleAsset, result)
    return result
}

/** Faster path for bulk download: skip waveform, defer pack cover, avoid re-reading cached MP3s. */
export async function materializeSampleInLibraryBulk(
    sampleAsset: SampleAsset,
    options?: { signal?: AbortSignal }
) {
    const result = await ensureSampleMp3OnDisk(sampleAsset, {
        cacheWaveform: false,
        skipPackCover: true,
        skipReadIfCached: true,
        quiet: true,
        signal: options?.signal,
    })
    await upsertMaterializedSample(sampleAsset, result)
    return result
}

export async function upsertSampleMetadataOnly(
    sampleAsset: SampleAsset,
    favorite?: boolean
) {
    await libraryUpsertFromAsset({
        asset: sampleAsset,
        relativeAudioPath: sampleRelativePath(sampleAsset),
        audioCachedAt: 0,
        favorite,
    })
}
