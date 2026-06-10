import type { SampleAsset } from "$lib/splice/types"
import { join, sep } from "@tauri-apps/api/path"
import { exists, create, mkdir, readFile } from "@tauri-apps/plugin-fs"
import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
import {
    fetchDescrambledMp3Bytes,
    mp3BlobUrl,
} from "$lib/shared/sample-bytes"
import { fetch } from "@tauri-apps/plugin-http"
import { waveformRelativePath } from "$lib/shared/waveform-data"
import { ensurePackCoverOnDisk as cachePackCover } from "$lib/shared/pack-cover"
import { sampleRelativePathFromAsset } from "$lib/shared/sample-path"

export function sampleRelativePath(sampleAsset: SampleAsset) {
    return sampleRelativePathFromAsset(sampleAsset)
}

export { waveformRelativePath }

async function ensureFileDirectoryExists(filePath: string) {
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

export async function absoluteSamplePath(sampleAsset: SampleAsset) {
    if (!config.samples_dir) {
        throw new Error("❌ Samples Directory not set")
    }

    if (!isSamplesDirValid()) {
        throw new Error("❌ Samples Directory invalid")
    }

    return await join(config.samples_dir, sampleRelativePath(sampleAsset))
}

export async function readSampleMp3Bytes(
    sampleAsset: SampleAsset
): Promise<Uint8Array | null> {
    if (!isSamplesDirValid()) return null
    try {
        const absolutePath = await absoluteSamplePath(sampleAsset)
        return await readFile(absolutePath)
    } catch {
        return null
    }
}

/** Waveform/cover/DB touch after play — does not read audio bytes when the file exists. */
export async function syncSampleLibraryFromDisk(
    sampleAsset: SampleAsset
): Promise<{
    absolutePath: string
    relativePath: string
    waveformRelativePath: string | null
} | null> {
    if (!config.samples_dir || !isSamplesDirValid()) return null

    const relativePath = sampleRelativePath(sampleAsset)
    const absolutePath = await join(config.samples_dir, relativePath)
    if (!(await exists(absolutePath))) return null

    const waveformRelativePath = await ensureWaveformSidecar(
        sampleAsset,
        relativePath
    )
    await cachePackCover(sampleAsset)

    return { absolutePath, relativePath, waveformRelativePath }
}

export async function ensureWaveformSidecar(
    sampleAsset: SampleAsset,
    relativeAudioPath: string
): Promise<string | null> {
    if (!config.samples_dir || !isSamplesDirValid()) return null

    const wfRel = waveformRelativePath(relativeAudioPath)
    const wfAbs = await join(config.samples_dir, wfRel)
    if (await exists(wfAbs)) return wfRel

    const waveUrl = sampleAsset.files[1]?.url
    if (!waveUrl) return null

    try {
        const response = await fetch(waveUrl)
        if (!response.ok) return null
        const buffer = await response.arrayBuffer()
        await ensureFileDirectoryExists(wfAbs)
        const file = await create(wfAbs)
        await file.write(new Uint8Array(buffer))
        await file.close()
        return wfRel
    } catch (e) {
        console.warn("⚠️ Waveform cache failed", e)
        return null
    }
}

export type MaterializedSample = {
    absolutePath: string
    relativePath: string
    bytes: Uint8Array
    waveformRelativePath: string | null
    wroteNewAudio: boolean
}

export type EnsureSampleMp3Options = {
    cacheWaveform?: boolean
    /** Bulk: pack covers are synced once per batch. */
    skipPackCover?: boolean
    /** Bulk: skip reading MP3 bytes when the file already exists. */
    skipReadIfCached?: boolean
    quiet?: boolean
    signal?: AbortSignal
}

export async function ensureSampleMp3OnDisk(
    sampleAsset: SampleAsset,
    options?: EnsureSampleMp3Options
): Promise<MaterializedSample> {
    if (!config.samples_dir || !isSamplesDirValid()) {
        throw new Error("❌ Samples Directory not set")
    }

    const relativePath = sampleRelativePath(sampleAsset)
    const absolutePath = await join(config.samples_dir, relativePath)

    let bytes: Uint8Array
    let wroteNewAudio = false

    if (await exists(absolutePath)) {
        bytes = options?.skipReadIfCached
            ? new Uint8Array(0)
            : await readFile(absolutePath)
    } else {
        bytes = await fetchDescrambledMp3Bytes(sampleAsset, {
            signal: options?.signal,
        })
        await ensureFileDirectoryExists(absolutePath)
        const file = await create(absolutePath)
        await file.write(bytes)
        await file.close()
        wroteNewAudio = true
        if (!options?.quiet) {
            console.log("💾 Saved sample MP3 at", absolutePath)
        }
    }

    let waveformRelativePath: string | null = null
    if (options?.cacheWaveform !== false) {
        waveformRelativePath = await ensureWaveformSidecar(
            sampleAsset,
            relativePath
        )
    }

    if (!options?.skipPackCover) {
        await cachePackCover(sampleAsset)
    }

    return {
        absolutePath,
        relativePath,
        bytes,
        waveformRelativePath,
        wroteNewAudio,
    }
}

/** @deprecated use ensureSampleMp3OnDisk */
export async function saveSample(sampleAsset: SampleAsset) {
    const { absolutePath } = await ensureSampleMp3OnDisk(sampleAsset)
    return absolutePath
}

export {
    ensurePackCoverOnDisk,
    absolutePackCoverPath,
} from "$lib/shared/pack-cover"

export async function savePackImage(sampleAsset: SampleAsset) {
    const { ensurePackCoverOnDisk } = await import("$lib/shared/pack-cover")
    return ensurePackCoverOnDisk(sampleAsset)
}
