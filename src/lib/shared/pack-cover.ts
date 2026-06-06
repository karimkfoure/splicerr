import { convertFileSrc } from "@tauri-apps/api/core"
import { join, sep } from "@tauri-apps/api/path"
import { create, exists, mkdir } from "@tauri-apps/plugin-fs"
import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import { sanitizePathSegment } from "$lib/shared/sample-path"
import type { PackAsset, SampleAsset } from "$lib/splice/types"
import { fetch } from "@tauri-apps/plugin-http"

const COVER_SLUGS = new Set(["cover_image", "generated_cover_image"])

export function isRemoteUrl(url: string | undefined) {
    return !!url && /^https?:\/\//i.test(url)
}

export function resolvePackCoverRemoteUrl(
    pack: PackAsset | undefined
): string | undefined {
    if (!pack) return undefined
    const fromField = pack.cover_source_url?.trim()
    if (isRemoteUrl(fromField)) return fromField

    const files = pack.files ?? []
    for (const slug of COVER_SLUGS) {
        const file = files.find((f) => f.asset_file_type_slug === slug)
        if (file?.url && isRemoteUrl(file.url)) return file.url
    }
    return files.map((f) => f.url).find((u) => isRemoteUrl(u))
}

export async function absolutePackCoverPath(packName: string) {
    if (!config.samples_dir) {
        throw new Error("❌ Samples Directory not set")
    }
    return await join(
        config.samples_dir,
        sanitizePathSegment(packName),
        "cover.jpg"
    )
}

async function ensurePackCoverDirectory(filePath: string) {
    const separator = sep()
    const dirs = filePath.split(separator).slice(0, -1)
    let currentPath = ""
    for (const dir of dirs) {
        currentPath += dir + separator
        if (!(await exists(currentPath))) {
            await mkdir(currentPath)
        }
    }
}

export async function localPackCoverAssetUrl(
    packName: string
): Promise<string | null> {
    if (!isSamplesDirValid() || !config.samples_dir) return null
    const path = await absolutePackCoverPath(packName)
    if (!(await exists(path))) return null
    return convertFileSrc(path)
}

export async function ensurePackCoverOnDisk(
    sampleAsset: SampleAsset
): Promise<string | null> {
    if (!isSamplesDirValid() || !config.samples_dir) return null

    const pack = sampleAsset.parents.items[0]
    if (!pack?.name) return null

    const absolutePath = await absolutePackCoverPath(pack.name)
    if (await exists(absolutePath)) {
        return absolutePath
    }

    const remoteUrl = resolvePackCoverRemoteUrl(pack)
    if (!remoteUrl) return null

    try {
        const response = await fetch(remoteUrl)
        if (!response.ok) throw new Error(`Failed to fetch cover: ${response.status}`)
        const buffer = await response.arrayBuffer()
        await ensurePackCoverDirectory(absolutePath)
        const file = await create(absolutePath)
        await file.write(new Uint8Array(buffer))
        await file.close()
        console.log("🖼️ Saved pack cover at", absolutePath)
        return absolutePath
    } catch (e) {
        console.warn("⚠️ Pack cover download failed", e)
        return null
    }
}

export async function syncPackCoversForAssets(assets: SampleAsset[]) {
    const seen = new Set<string>()
    for (const asset of assets) {
        const pack = asset.parents.items[0]
        if (!pack?.uuid || seen.has(pack.uuid)) continue
        seen.add(pack.uuid)
        await ensurePackCoverOnDisk(asset)
    }
}
