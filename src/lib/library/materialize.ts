import type { SampleAsset } from "$lib/splice/types"
import {
    ensureSampleMp3OnDisk,
    sampleRelativePath,
} from "$lib/shared/files.svelte"
import { libraryUpsertFromAsset } from "./api"
import { setCachedInLibrary } from "./session-cache.svelte"

export async function materializeSampleInLibrary(sampleAsset: SampleAsset) {
    const result = await ensureSampleMp3OnDisk(sampleAsset)
    const now = Date.now()
    await libraryUpsertFromAsset({
        asset: sampleAsset,
        relativeAudioPath: result.relativePath,
        waveformRelativePath: result.waveformRelativePath,
        audioCachedAt: now,
    })
    setCachedInLibrary(sampleAsset.uuid, true)
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
