import type { PackAsset, SampleAsset } from "$lib/splice/types"
import { config } from "$lib/shared/config.svelte"
import {
    dataStore,
    freeDescrambledSample,
    getCachedDescrambledPlaybackUrl,
    getPlaybackSampleURL,
    prefetchNeighborPlaybackUrls,
    prefetchPlaybackUrl,
    SamplesDirRequiredError,
} from "$lib/shared/store.svelte"
import { isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import { semitonesFor } from "$lib/shared/transpose.svelte"

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
            prefetchPlaybackUrl(sampleAsset)
        }
    },
    applyPlaybackSrc(sampleAsset: SampleAsset, src: string, from: number = 0) {
        const delay = config.cut_mp3_delay ? 0.012 : 0
        const start = from > 0 ? from : delay
        const assetUuid = sampleAsset.uuid

        this.currentTime = start
        this.ref.pause()
        this.ref.loop =
            sampleAsset.asset_category_slug == "loop" && config.repeat_audio

        const begin = () => {
            if (this.currentAsset?.uuid !== assetUuid) return
            this.ref.currentTime = start
            this.currentTime = start
            void this.ref.play()
        }

        if (this.ref.src === src && this.ref.readyState >= 1) {
            begin()
            return
        }

        this.ref.addEventListener("loadedmetadata", () => begin(), { once: true })
        this.ref.src = src
    },
    async playSampleAsset(sampleAsset: SampleAsset, from: number = 0) {
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
        if (from <= 0) {
            this.currentTime = 0
        }
        if (!isSamplesDirValid()) {
            settingsDialog.open = true
            return
        }

        if (!semitonesFor(sampleAsset)) {
            const cached = getCachedDescrambledPlaybackUrl(sampleAsset.uuid)
            if (cached) {
                this.applyPlaybackSrc(sampleAsset, cached, from)
                prefetchNeighborPlaybackUrls(sampleAsset)
                return
            }
        }

        try {
            const src = await getPlaybackSampleURL(sampleAsset)
            if (this.currentAsset.uuid != sampleAsset.uuid) {
                return
            }
            this.applyPlaybackSrc(sampleAsset, src, from)
            prefetchNeighborPlaybackUrls(sampleAsset)
        } catch (e) {
            if (e instanceof SamplesDirRequiredError) {
                settingsDialog.open = true
            }
            throw e
        }
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
