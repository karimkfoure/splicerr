/** One bulk or pack-sync download run at a time (no shared governor). */

export type DownloadSessionTag = "bulk-download" | "pack-sync"

let activeTag: DownloadSessionTag | null = null

export function getActiveDownloadSessionTag(): DownloadSessionTag | null {
    return activeTag
}

export function tryClaimDownloadSession(tag: DownloadSessionTag): boolean {
    if (activeTag != null && activeTag !== tag) return false
    activeTag = tag
    return true
}

export function releaseDownloadSession(tag: DownloadSessionTag) {
    if (activeTag === tag) activeTag = null
}
