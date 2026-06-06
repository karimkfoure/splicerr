import type { PackAsset, SampleAsset } from "$lib/splice/types"
import { loading } from "$lib/shared/loading.svelte"
import { config } from "$lib/shared/config.svelte"
import {
    dataStore,
    freeDescrambledSample,
    getPlaybackSampleURL,
    SamplesDirRequiredError,
} from "$lib/shared/store.svelte"
import { isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"

let prevVolume = 0.8

export const globalAudio = $state({
    ref: null! as HTMLAudioElement,
    currentAsset: null as SampleAsset | null, // TODO: selected asset & audio player asset need to be thought through again
    paused: true,
    currentTime: 0,
    duration: 0,
    loading: false,
    volume: 0.8,
    progress() {
        return this.currentTime / this.duration
    },
    togglePlay() {
        this.paused = !this.paused
    },
    toggleMute() {
        if (this.volume > 0) {
            prevVolume = this.volume
            this.volume = 0
        } else {
            this.volume = prevVolume
        }
    },
    async selectSampleAsset(sampleAsset: SampleAsset, play: boolean = true) {
        if (this.currentAsset?.uuid != sampleAsset.uuid) {
            this.paused = true
            this.currentTime = 0

            if (this.currentAsset) {
                if (
                    !dataStore.sampleAssets.some(
                        (other) => this.currentAsset?.uuid == other.uuid
                    )
                ) {
                    freeDescrambledSample(this.currentAsset.uuid)
                }
            }

            this.currentAsset = sampleAsset
            // this.ref.src = await getDescrambledSampleURL(sampleAsset)
        }
        // if (play) {
        //     this.playSampleAsset(sampleAsset)
        // }
        // TODO: this is kinda borked
    },
    async playSampleAsset(sampleAsset: SampleAsset, from: number = 0) {
        if (loading.samples.has(sampleAsset.uuid)) {
            console.info("🐢 Already loading sample")
            return
        }
        this.ref.src = ""
        this.currentTime = 0

        if (this.currentAsset) {
            if (
                !dataStore.sampleAssets.some(
                    (other) => this.currentAsset?.uuid == other.uuid
                )
            ) {
                freeDescrambledSample(this.currentAsset.uuid)
            }
        }

        this.currentAsset = sampleAsset
        if (!isSamplesDirValid()) {
            settingsDialog.open = true
            return
        }
        try {
            this.ref.src = await getPlaybackSampleURL(sampleAsset)
        } catch (e) {
            if (e instanceof SamplesDirRequiredError) {
                settingsDialog.open = true
            }
            throw e
        }
        if (this.currentAsset.uuid != sampleAsset.uuid) {
            return
        }
        const delay = config.cut_mp3_delay ? 0.012 : 0
        this.ref.currentTime = from > 0 ? from : delay
        this.ref.loop = sampleAsset.asset_category_slug == "loop" && config.repeat_audio
        this.ref.play()
    },
    // Reload the currently playing sample (e.g. after transpose settings change),
    // preserving playback position and play/pause state.
    async reloadCurrent() {
        const asset = this.currentAsset
        if (!asset) return
        const wasPaused = this.paused
        const from = this.ref.currentTime || 0
        const src = await getPlaybackSampleURL(asset)
        if (this.currentAsset?.uuid != asset.uuid) return
        this.ref.src = src
        this.ref.currentTime = from
        this.ref.loop =
            asset.asset_category_slug == "loop" && config.repeat_audio
        if (!wasPaused) this.ref.play()
    },
})
