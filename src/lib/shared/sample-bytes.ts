import { descrambleSample } from "$lib/splice/descrambler"
import type { SampleAsset } from "$lib/splice/types"
import { fetch } from "@tauri-apps/plugin-http"

export async function fetchDescrambledMp3Bytes(
    sampleAsset: SampleAsset,
    options?: { signal?: AbortSignal }
): Promise<Uint8Array> {
    const response = await fetch(sampleAsset.files[0].url, {
        signal: options?.signal,
    })
    const data = new Uint8Array(await response.arrayBuffer())
    return descrambleSample(data)
}

export function mp3BlobUrl(bytes: Uint8Array): string {
    const blob = new Blob([bytes], { type: "audio/mp3" })
    return window.URL.createObjectURL(blob)
}
