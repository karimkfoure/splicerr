import { readFile } from "@tauri-apps/plugin-fs"
import pako from "pako"

export function waveformRelativePath(relativeAudioPath: string) {
    return `${relativeAudioPath}.waveform.gz`
}

export function parseWaveformBytes(bytes: Uint8Array): number[] {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const inflated = pako.inflate(bytes, { to: "string" })
        return JSON.parse(inflated)
    }
    const text = new TextDecoder().decode(bytes).trim()
    if (text.startsWith("[")) {
        return JSON.parse(text)
    }
    throw new Error("Unrecognized waveform sidecar format")
}

export function fileUrlToPath(fileUrl: string): string {
    return decodeURIComponent(fileUrl.replace(/^file:\/\//, ""))
}

export async function loadWaveformFromSrc(src: string): Promise<number[]> {
    if (!src) {
        throw new Error("Empty waveform source")
    }
    if (src.startsWith("file://")) {
        const path = fileUrlToPath(src)
        const bytes = await readFile(path)
        return parseWaveformBytes(bytes)
    }
    const { fetch } = await import("@tauri-apps/plugin-http")
    const resp = await fetch(src)
    if (!resp.ok) {
        throw new Error(`Waveform fetch failed: ${resp.status}`)
    }
    if (resp.headers.get("content-encoding") === "gzip") {
        const buff = await resp.arrayBuffer()
        return parseWaveformBytes(new Uint8Array(buff))
    }
    return resp.json()
}
