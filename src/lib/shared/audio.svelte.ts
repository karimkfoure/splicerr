import type { PackAsset, SampleAsset } from "$lib/splice/types"
import { loading } from "$lib/shared/loading.svelte"
import { config } from "$lib/shared/config.svelte"
import {
    dataStore,
    freeDescrambledSample,
    getDescrambledSampleURL,
} from "$lib/shared/store.svelte"
import { terminalLog } from "$lib/shared/terminal-log"

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
        if (!this.ref) return
        if (this.paused) {
            void this.ref.play().then(() => {
                this.paused = false
            })
        } else {
            this.ref.pause()
            this.paused = true
        }
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
        void terminalLog(`play: ${sampleAsset.name.split("/").pop() ?? sampleAsset.uuid}`)
        if (!this.ref) {
            console.error("⚠️ Audio element not mounted yet")
            void terminalLog("play: aborted — audio ref missing")
            return
        }
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
        try {
            this.ref.src = await getDescrambledSampleURL(sampleAsset)
        } catch (error) {
            console.error("⚠️ Failed to load sample", error)
            this.ref.src = ""
            this.loading = false
            return
        }
        if (this.currentAsset.uuid != sampleAsset.uuid) {
            return
        }
        this.ref.currentTime = from
        this.ref.loop = sampleAsset.asset_category_slug == "loop" && config.repeat_audio
        try {
            await this.ref.play()
            this.paused = false
            void terminalLog("play: started")
        } catch (error) {
            console.error("⚠️ Audio play() rejected", error)
            void terminalLog(
                `play: rejected ${error instanceof Error ? error.message : String(error)}`
            )
            this.paused = true
        }
    },
})
