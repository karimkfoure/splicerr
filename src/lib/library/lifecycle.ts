import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import { libraryClose, libraryOpen } from "./api"
import { clearInLibraryCache } from "./session-cache.svelte"

export async function syncLibraryConnection() {
    if (!isSamplesDirValid() || !config.samples_dir) {
        await libraryClose().catch(() => {})
        clearInLibraryCache()
        return
    }
    await libraryOpen(config.samples_dir)
}
