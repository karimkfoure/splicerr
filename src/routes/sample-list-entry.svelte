<script lang="ts">
    import { globalAudio } from "$lib/shared/audio.svelte"
    import PackPreview from "$lib/components/pack-preview.svelte"
    import TagBadge from "$lib/components/tag-badge.svelte"
    import Waveform from "$lib/components/waveform.svelte"
    import type { SampleAsset } from "$lib/splice/types"
    import CircleX from "lucide-svelte/icons/circle-x"
    import Pause from "lucide-svelte/icons/pause"
    import Play from "lucide-svelte/icons/play"
    import Button from "$lib/components/ui/button/button.svelte"
    import * as Tooltip from "$lib/components/ui/tooltip/index.js"
    import LoaderCircle from "lucide-svelte/icons/loader-circle"
    import {
        applyPackFilter,
        browseStore,
        dataStore,
        fetchAssets,
    } from "$lib/shared/store.svelte"
    import { cn, formatKey } from "$lib/utils"
    import { loading } from "$lib/shared/loading.svelte"
    import { assetIcons } from "$lib/shared/icons.svelte"
    import {
        handleSampleDrag,
        handleSampleDownload,
    } from "$lib/shared/drag.svelte"
    import Download from "lucide-svelte/icons/download"
    import Star from "lucide-svelte/icons/star"
    import {
        getCachedInLibrary,
        getCachedFavorite,
        inLibraryState,
        setCachedFavorite,
        setCachedInLibrary,
    } from "$lib/library/session-cache.svelte"
    import { librarySetFavorite } from "$lib/library/api"
    import { regenerateExportedSampleWav } from "$lib/library/export"
    import { sampleRelativePath } from "$lib/shared/files.svelte"
    import { sampleDisplayFileName } from "$lib/shared/sample-path"

    let {
        class: className,
        selected,
        playing,
        sampleAsset,
    }: {
        class?: string
        selected: boolean
        playing: boolean
        sampleAsset: SampleAsset
    } = $props()

    let playButtonRef = $state<HTMLButtonElement>(null!)
    let downloading = $state(false)
    let favoriting = $state(false)

    const inLibrary = $derived(
        browseStore.mode === "library" ||
        (inLibraryState.version >= 0 &&
            getCachedInLibrary(sampleAsset.uuid))
    )
    const isFavorite = $derived(
        inLibraryState.version >= 0 &&
            (sampleAsset.favorite ?? getCachedFavorite(sampleAsset.uuid))
    )

    $effect(() => {
        if (selected) {
            playButtonRef.focus({ preventScroll: true })
        }
    })

    const pack = $derived(sampleAsset.parents.items[0])
    const packName = $derived(
        pack?.name ? pack.name.split("/").slice(-1)[0] : ""
    )
    const name = $derived(
        sampleAsset.display_name
            ? sampleDisplayFileName(sampleAsset.display_name)
            : sampleDisplayFileName(sampleAsset.name)
    )

    const millisToMinutesAndSeconds = (millis: number) => {
        var minutes = Math.floor(millis / 60000)
        var seconds = Math.floor((millis % 60000) / 1000)
        return minutes + ":" + (seconds < 10 ? "0" : "") + seconds
    }

    function onPackNamePointerDown(event: PointerEvent) {
        if (!pack?.uuid) return
        event.stopPropagation()
    }

    function onPackNameClick(event: MouseEvent) {
        if (!pack?.uuid) return
        event.stopPropagation()
        event.preventDefault()
        applyPackFilter(pack)
    }
</script>

<button
    class={cn(
        "flex gap-4 items-center justify-between p-1 rounded-lg focus:outline-none cursor-grab",
        selected && "bg-muted",
        className
    )}
    id={`sample-list-entry-${sampleAsset.uuid}`}
    draggable="true"
    tabindex="-1"
    onmousedown={() => globalAudio.selectSampleAsset(sampleAsset, false)}
    ondragstart={(event) => handleSampleDrag(event, sampleAsset)}
>
    <div
        class="flex items-center gap-2 min-w-[8.5rem] w-44 flex-shrink-0"
    >
        <PackPreview {pack} />
        <div class="flex min-h-12 min-w-0 flex-1 items-center">
            <Tooltip.Provider>
                <Tooltip.Root>
                    <Tooltip.Trigger
                        class={cn(
                            "block w-full min-w-0 text-left",
                            pack?.uuid
                                ? "cursor-pointer hover:underline"
                                : "cursor-grab"
                        )}
                        onpointerdown={onPackNamePointerDown}
                        onclick={onPackNameClick}
                    >
                        <span
                            class={cn(
                                "pack-row-name text-xs text-muted-foreground",
                                pack?.uuid && "hover:text-foreground"
                            )}
                        >
                            {packName || "—"}
                        </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                        {pack?.uuid
                            ? `Filter by pack: ${packName}`
                            : packName || "—"}
                    </Tooltip.Content>
                </Tooltip.Root>
            </Tooltip.Provider>
        </div>
    </div>
    <Button
        variant="ghost"
        bind:ref={playButtonRef}
        class="group flex-shrink-0 focus:outline-none"
        size="icon-lg"
        onclick={() =>
            playing
                ? globalAudio.ref.pause()
                : globalAudio.playSampleAsset(sampleAsset)}
    >
        {#if (selected && globalAudio.loading) || (loading.samplesCount && loading.samples.has(sampleAsset.uuid))}
            <LoaderCircle class="animate-spin" />
        {:else if playing}
            <Pause />
        {:else}
            <Play class="group-hover:block hidden" />
            {#if sampleAsset.asset_category_slug in assetIcons}
                {@const Icon = assetIcons[sampleAsset.asset_category_slug]}
                <Icon class="group-hover:hidden" />
            {:else}
                <CircleX class="group-hover:hidden" />
            {/if}
        {/if}
    </Button>
    <div class="min-w-32 w-96 flex-[3_1_auto] overflow-clip">
        <div
            class={cn(
                "text-left relative after:content-[''] after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-gradient-to-r after:from-transparent after:pointer-events-none",
                selected ? " after:to-muted" : "after:to-background"
            )}
        >
            <Tooltip.Provider>
                <Tooltip.Root>
                    <Tooltip.Trigger
                        class="overflow-clip text-nowrap cursor-grab"
                    >
                        {name}
                    </Tooltip.Trigger>
                    <Tooltip.Content>
                        {name}
                    </Tooltip.Content>
                </Tooltip.Root>
            </Tooltip.Provider>
            <div class="flex gap-0.5 text-xs overflow-clip text-nowrap">
                {#each sampleAsset.tags as tag}
                    {@const active = dataStore.tags.includes(tag.uuid)}
                    {@const tag_summary_tag = dataStore.tag_summary.find(
                        (t: any) => t.tag.uuid == tag.uuid
                    )}
                    <TagBadge
                        label={tag.label}
                        variant="ghost"
                        class="px-1 py-0.5 h-auto"
                        count={tag_summary_tag?.count ?? 0}
                        onclick={() => {
                            if (!active) {
                                dataStore.tags.push(tag.uuid)
                                // updateTagSummary()
                                fetchAssets()
                            }
                        }}
                    />
                {/each}
            </div>
        </div>
    </div>
    <Waveform
        src={sampleAsset.files[1].url}
        progress={selected ? globalAudio.progress() : 0}
        onseek={(progress) => {
            const startTime = progress * (sampleAsset.duration / 1000)
            globalAudio.playSampleAsset(sampleAsset, startTime)
        }}
        class="min-w-32 w-[150px] h-12 flex-grow md:block hidden"
    />
    <div class="text-muted-foreground flex-shrink-0 w-14 flex-grow">
        {millisToMinutesAndSeconds(sampleAsset.duration)}
    </div>
    <div class="text-muted-foreground flex-shrink-0 w-14 flex-grow">
        {(sampleAsset.key &&
            formatKey(sampleAsset.key, sampleAsset.chord_type)) ??
            "--"}
    </div>
    <div class="text-muted-foreground flex-shrink-0 w-14 flex-grow">
        {sampleAsset.bpm ?? "--"}
    </div>
    <Tooltip.Provider>
        <Tooltip.Root>
            <Tooltip.Trigger>
                <Button
                    variant="ghost"
                    class="flex-shrink-0 text-muted-foreground"
                    size="icon"
                    disabled={favoriting}
                    onclick={async (e) => {
                        e.stopPropagation()
                        favoriting = true
                        try {
                            const next = !isFavorite
                            if (next) {
                                await regenerateExportedSampleWav(sampleAsset)
                                setCachedInLibrary(sampleAsset.uuid, true)
                            }
                            await librarySetFavorite(
                                sampleAsset.uuid,
                                next,
                                sampleAsset,
                                sampleRelativePath(sampleAsset)
                            )
                            setCachedFavorite(sampleAsset.uuid, next)
                            sampleAsset.favorite = next
                        } finally {
                            favoriting = false
                        }
                    }}
                >
                    <Star
                        class={cn(
                            isFavorite && "fill-amber-400 text-amber-400"
                        )}
                    />
                </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Favorite</Tooltip.Content>
        </Tooltip.Root>
    </Tooltip.Provider>
    <Tooltip.Provider>
        <Tooltip.Root>
            <Tooltip.Trigger>
                <Button
                    variant="ghost"
                    class="flex-shrink-0 text-muted-foreground"
                    size="icon"
                    disabled={downloading}
                    onclick={async (e) => {
                        e.stopPropagation()
                        downloading = true
                        try {
                            await handleSampleDownload(sampleAsset)
                            setCachedInLibrary(sampleAsset.uuid, true)
                        } finally {
                            downloading = false
                        }
                    }}
                >
                    {#if downloading}
                        <LoaderCircle class="animate-spin" />
                    {:else}
                        <Download />
                    {/if}
                </Button>
            </Tooltip.Trigger>
            <Tooltip.Content
                >Export WAV</Tooltip.Content
            >
        </Tooltip.Root>
    </Tooltip.Provider>
</button>

<style>
    .pack-row-name {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
        line-height: 1.25;
        word-break: break-word;
    }
</style>
