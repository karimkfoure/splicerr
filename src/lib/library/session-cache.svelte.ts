export const inLibraryState = $state({
    byUuid: {} as Record<string, boolean>,
    favoriteByUuid: {} as Record<string, boolean>,
    version: 0,
})

export function getCachedInLibrary(uuid: string): boolean {
    return inLibraryState.byUuid[uuid] ?? false
}

export function getCachedFavorite(uuid: string): boolean {
    return inLibraryState.favoriteByUuid[uuid] ?? false
}

export function setCachedInLibrary(uuid: string, value: boolean) {
    inLibraryState.byUuid[uuid] = value
    inLibraryState.version++
}

export function setCachedFavorite(uuid: string, value: boolean) {
    inLibraryState.favoriteByUuid[uuid] = value
    inLibraryState.version++
}

export function mergeBatchFlags(
    batch: Record<string, { inLibrary: boolean; favorite: boolean }>
) {
    for (const [uuid, flags] of Object.entries(batch)) {
        inLibraryState.byUuid[uuid] = flags.inLibrary
        inLibraryState.favoriteByUuid[uuid] = flags.favorite
    }
    inLibraryState.version++
}

export function clearInLibraryCache() {
    inLibraryState.byUuid = {}
    inLibraryState.favoriteByUuid = {}
    inLibraryState.version++
}
