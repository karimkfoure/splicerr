import type { PackAsset } from "$lib/splice/types"

export function splicePackChildTypeCount(
    pack: PackAsset,
    type: string
): number {
    const rows = pack.child_asset_counts
    if (!rows?.length) return 0
    let total = 0
    for (const row of rows) {
        if (row.type === type && row.count > 0) {
            total += row.count
        }
    }
    return total
}

/** Published sample count from Splice pack metadata (`child_asset_counts` type `sample`). */
export function splicePackSampleTotal(pack: PackAsset): number | null {
    const n = splicePackChildTypeCount(pack, "sample")
    return n > 0 ? n : null
}

/** MIDI files in the pack (not mirrored as preview MP3s). */
export function splicePackMidiTotal(pack: PackAsset): number | null {
    const n = splicePackChildTypeCount(pack, "midi")
    return n > 0 ? n : null
}

/**
 * Denominator for mirror progress: prefer Splice sample-search `records` (listable
 * MP3 previews), then metadata minus explicit MIDI children when Splice splits them.
 */
export function packMirrorTargetTotal(
    pack: PackAsset,
    listableTotal?: number | null
): number | null {
    if (listableTotal != null && listableTotal > 0) return listableTotal
    const samples = splicePackSampleTotal(pack)
    if (samples == null) return null
    const midi = splicePackMidiTotal(pack)
    if (midi != null && midi > 0 && midi < samples) return samples - midi
    return samples
}

export function isPackFullyCached(
    pack: PackAsset,
    cachedCount: number,
    knownTotal?: number | null
): boolean {
    const total = knownTotal ?? packMirrorTargetTotal(pack)
    if (total == null || total <= 0) return false
    return cachedCount >= total
}

/** Listed every hit in the last pack-scoped search and all are on disk (search scope only). */
export function isPackSyncCatalogComplete(row: {
    syncListingComplete?: boolean
    listed: number
    listedInLibrary: number
} | undefined): boolean {
    if (!row?.syncListingComplete) return false
    if (row.listed <= 0) return false
    return row.listedInLibrary >= row.listed
}

/** Full-pack mirror complete vs listable MP3 catalog (not raw metadata when they differ). */
export function isPackMirrorComplete(
    pack: PackAsset,
    cachedCount: number,
    listableTotal?: number | null
): boolean {
    return isPackFullyCached(
        pack,
        cachedCount,
        packMirrorTargetTotal(pack, listableTotal)
    )
}
