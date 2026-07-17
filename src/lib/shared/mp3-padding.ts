const MP3_ENCODER_DELAY_SAMPLES = 576
const MP3_DECODER_DELAY_SAMPLES = 529
export const DEFAULT_MP3_START_TRIM_SAMPLES =
    MP3_ENCODER_DELAY_SAMPLES + MP3_DECODER_DELAY_SAMPLES
const FALLBACK_SAMPLE_RATE = 44_100

/** Read the first valid MPEG Layer III frame header without decoding the file. */
export function mp3SampleRate(bytes: Uint8Array): number | null {
    const limit = Math.min(bytes.length - 3, 16 * 1024)
    for (let offset = 0; offset < limit; offset++) {
        const header =
            ((bytes[offset] << 24) |
                (bytes[offset + 1] << 16) |
                (bytes[offset + 2] << 8) |
                bytes[offset + 3]) >>> 0
        if ((header & 0xffe00000) !== 0xffe00000) continue
        const version = (header >>> 19) & 0x3
        const layer = (header >>> 17) & 0x3
        const bitrateIndex = (header >>> 12) & 0xf
        const rateIndex = (header >>> 10) & 0x3
        if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue
        const rates = version === 3
            ? [44_100, 48_000, 32_000]
            : version === 2
              ? [22_050, 24_000, 16_000]
              : [11_025, 12_000, 8_000]
        return rates[rateIndex]
    }
    return null
}

export function mp3StartTrimSeconds(bytes: Uint8Array): number {
    return DEFAULT_MP3_START_TRIM_SAMPLES / (mp3SampleRate(bytes) ?? FALLBACK_SAMPLE_RATE)
}
