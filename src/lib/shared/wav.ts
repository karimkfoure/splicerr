import { encode } from "node-wav"
import { Buffer } from "buffer"

globalThis.Buffer = Buffer // node-wav needs Buffer which is not defined when using Vite

let sharedContext: AudioContext | null = null
const audioContext = () => (sharedContext ??= new AudioContext())

/** Decode an (already descrambled) audio blob URL into an AudioBuffer. */
export async function decodeAudioFromURL(url: string): Promise<AudioBuffer> {
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    return await audioContext().decodeAudioData(arrayBuffer)
}

/** Encode an AudioBuffer to 16-bit PCM WAV bytes. */
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
    const channels: Float32Array[] = []
    for (let i = 0; i < buffer.numberOfChannels; i++) {
        channels.push(buffer.getChannelData(i))
    }
    const wavData = encode(channels as any, {
        sampleRate: buffer.sampleRate,
        bitDepth: 16,
    })
    return new Uint8Array(wavData)
}
