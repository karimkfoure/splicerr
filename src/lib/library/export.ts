import type { SampleAsset } from "$lib/splice/types"
import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import { materializeSampleInLibrary } from "$lib/library/materialize"
import { exportSampleWav } from "$lib/library/api"

/**
 * Materialize the source MP3, then atomically regenerate its permanent derived
 * WAV under samples_dir/exported while preserving the relative pack tree.
 */
export async function regenerateExportedSampleWav(sample: SampleAsset) {
    if (!config.samples_dir || !isSamplesDirValid()) {
        throw new Error("Samples directory is not configured")
    }
    const materialized = await materializeSampleInLibrary(sample)
    return exportSampleWav({
        samplesDir: config.samples_dir,
        relativeAudioPath: materialized.relativePath,
        assetCategorySlug: sample.asset_category_slug,
        durationMs: sample.duration,
        bpm: sample.bpm,
        correctionEnabled: config.wav_correction_enabled,
    })
}
