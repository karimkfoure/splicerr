import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import { exportMissingFavoriteWavs, libraryClose, libraryOpen } from "./api"
import { clearInLibraryCache } from "./session-cache.svelte"

let favoriteExportsReconciledFor: string | null = null

export async function syncLibraryConnection() {
    if (!isSamplesDirValid() || !config.samples_dir) {
        await libraryClose().catch(() => {})
        clearInLibraryCache()
        favoriteExportsReconciledFor = null
        return
    }
    await libraryOpen(config.samples_dir)
    if (favoriteExportsReconciledFor === config.samples_dir) return
    const samplesDir = config.samples_dir
    favoriteExportsReconciledFor = samplesDir
    void exportMissingFavoriteWavs(samplesDir)
        .then((summary) => {
            if (summary.exported || summary.regenerated || summary.failed) {
                console.info("Favorite WAV reconciliation", summary)
            }
        })
        .catch((error) => {
            if (favoriteExportsReconciledFor === samplesDir) {
                favoriteExportsReconciledFor = null
            }
            console.error("Favorite WAV reconciliation failed", error)
        })
}
