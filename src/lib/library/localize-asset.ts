import { convertFileSrc } from "@tauri-apps/api/core"
import type { SampleAsset } from "$lib/splice/types"

function localizeUrl(url: string | undefined): string {
    if (!url) return ""
    if (!url.startsWith("file://")) return url
    const path = decodeURIComponent(url.replace(/^file:\/\//, ""))
    return convertFileSrc(path)
}

export function localizeSampleAsset(asset: SampleAsset): SampleAsset {
    const pack = asset.parents.items[0]
    return {
        ...asset,
        files: asset.files.map((f, i) => ({
            ...f,
            // Preserve sidecar URLs for compatibility/auditing. The visible
            // waveform is computed locally from the cached MP3 instead.
            url: i === 0 ? localizeUrl(f.url) : f.url,
        })),
        parents: {
            ...asset.parents,
            items: [
                {
                    ...pack,
                    files: pack.files.map((f) => ({
                        ...f,
                        url: localizeUrl(f.url),
                    })),
                },
            ],
        },
    }
}
