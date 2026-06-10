import type { PackAsset } from "$lib/splice/types"
import {
    libraryPackPopularityScores,
    recordPackRankObservations,
} from "$lib/library/api"
import { isSamplesDirValid } from "$lib/shared/config.svelte"

/** Stable scope id for pack popularity snapshots. */
export function buildPackPopularityScopeKey(tags: string[]): string {
    const sorted = [...tags].sort()
    return `packs|tags:${sorted.join(",")}|sort:popularity`
}

export function absolutePackRank(
    page: number,
    limit: number,
    indexInPage: number
): number {
    return (Math.max(1, page) - 1) * limit + indexInPage + 1
}

export type PackPopularityScore = {
    score: number
    bestRank: number | null
    observationCount: number
    updatedAt: number
}

/** Fire-and-forget: record ranks from a PacksSearch page (existing API traffic). */
export function capturePackRankPage(
    scopeKey: string,
    packs: PackAsset[],
    page: number,
    limit: number,
    source = "packs_search"
) {
    if (!isSamplesDirValid() || !packs.length) return
    const now = Date.now()
    const observations = packs.map((pack, index) => ({
        packUuid: pack.uuid,
        packName: pack.name.split("/").slice(-1)[0] || pack.name,
        rank: absolutePackRank(page, limit, index),
        observedAt: now,
        source,
    }))
    void recordPackRankObservations({ scopeKey, observations }).catch((e) => {
        console.warn("Failed to record pack rank observations", e)
    })
}

export async function fetchPackPopularityScores(
    scopeKey: string,
    packUuids?: string[]
): Promise<Record<string, PackPopularityScore>> {
    if (!isSamplesDirValid()) return {}
    return libraryPackPopularityScores(scopeKey, packUuids)
}

export function sortPacksByLocalPopularity(
    packs: PackAsset[],
    scores: Record<string, PackPopularityScore>
): PackAsset[] {
    const withScore = packs.filter((p) => scores[p.uuid] != null)
    if (withScore.length === 0) return packs
    return [...packs].sort((a, b) => {
        const sa = scores[a.uuid]?.score ?? -1
        const sb = scores[b.uuid]?.score ?? -1
        if (sb !== sa) return sb - sa
        return a.name.localeCompare(b.name)
    })
}
