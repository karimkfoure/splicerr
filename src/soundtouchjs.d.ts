declare module "soundtouchjs" {
    export class SoundTouch {
        pitch: number
        pitchOctaves: number
        pitchSemitones: number
        tempo: number
        rate: number
    }

    export class WebAudioBufferSource {
        constructor(buffer: AudioBuffer)
    }

    export class SimpleFilter {
        constructor(
            sourceSound: WebAudioBufferSource,
            pipe: SoundTouch,
            callback?: () => void
        )
        /** Fills `target` (interleaved stereo) with up to `numFrames` frames; returns frames written. */
        extract(target: Float32Array, numFrames?: number): number
        sourcePosition: number
    }

    export class PitchShifter {
        constructor(
            context: AudioContext,
            buffer: AudioBuffer,
            bufferSize: number,
            onEnd?: () => void
        )
    }
}
