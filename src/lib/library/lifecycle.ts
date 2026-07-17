import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import { exportMissingFavoriteWavs, libraryClose, libraryOpen } from "./api"
import { clearInLibraryCache } from "./session-cache.svelte"

export async function syncLibraryConnection() {
    if (!isSamplesDirValid() || !config.samples_dir) {
        await libraryClose().catch(() => {})
        clearInLibraryCache()
        return
    }
    await libraryOpen(config.samples_dir)
    void exportMissingFavoriteWavs(config.samples_dir)
        .then((summary) => {
            if (summary.exported || summary.failed) {
                console.info("Favorite WAV reconciliation", summary)
            }
        })
        .catch((error) => console.error("Favorite WAV reconciliation failed", error))
}
