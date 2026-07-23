<script lang="ts">
    import SampleListEntry from "./sample-list-entry.svelte"
    import SearchInput from "$lib/components/search-input.svelte"
    import { ScrollArea } from "$lib/components/ui/scroll-area"
    import { onMount, tick } from "svelte"
    import SortSelect from "$lib/components/sort-select.svelte"
    import Search from "lucide-svelte/icons/search"
    import Smile from "lucide-svelte/icons/smile"
    import Ghost from "lucide-svelte/icons/ghost"
    import Shuffle from "lucide-svelte/icons/shuffle"
    import Download from "lucide-svelte/icons/download"
    import LoaderCircle from "lucide-svelte/icons/loader-circle"
    import Package from "lucide-svelte/icons/package"
    import Database from "lucide-svelte/icons/database"
    import Button from "$lib/components/ui/button/button.svelte"
    import ProgressLoading from "$lib/components/progress-loading.svelte"
    import Separator from "$lib/components/ui/separator/separator.svelte"
    import SortHeader from "$lib/components/sort-header.svelte"
    import { SAMPLE_LIST_GRID } from "$lib/shared/sample-list-layout"
    import ChevronDown from "lucide-svelte/icons/chevron-down"
    import { cn } from "$lib/utils"
    import AssetCategorySelect from "$lib/components/asset-category-select.svelte"
    import BpmSelect from "$lib/components/bpm-select.svelte"
    import AudioPlayer from "$lib/components/audio-player.svelte"
    import TagBadge from "$lib/components/tag-badge.svelte"
    import { globalAudio } from "$lib/shared/audio.svelte"
    import type { AssetSortType } from "$lib/splice/types"
    import { loading } from "$lib/shared/loading.svelte"
    import {
        dataStore,
        storeCallbacks,
        queryStore,
        fetchAssets,
        DEFAULT_SORT,
        randomSeed,
        browseStore,
        resetAssetList,
        switchBrowseMode,
    } from "$lib/shared/store.svelte"
    import SettingsDialog from "$lib/components/settings-dialog.svelte"
    import {
        configLoadState,
        getConnectedLibraryDir,
        isSamplesDirValid,
    } from "$lib/shared/config.svelte"
    import * as Dialog from "$lib/components/ui/dialog"
    import KeySelect from "$lib/components/key-select.svelte"
    import PackSelect from "$lib/components/pack-select.svelte"
    import SamplePackSyncDialog from "$lib/components/sample-pack-sync-dialog.svelte"
    import MirrorBackfillDialog from "$lib/components/mirror-backfill-dialog.svelte"
    import {
        bulkDownloadState,
        downloadAllSpliceResults,
        requestStopBulkDownload,
    } from "$lib/shared/bulk-download.svelte"
    import { getActiveDownloadSessionTag } from "$lib/shared/download-session"
    import { packSyncManager } from "$lib/shared/pack-sync.svelte"
    import { mirrorBackfillState } from "$lib/shared/mirror-backfill.svelte"
    import { toast } from "$lib/shared/toast.svelte"

    // TODO: Taxonomy comboboxes (maybe just pass all tags to each)
    // const instrumentTags = $derived(() =>
    //     dataStore.tag_summary.filter(
    //         (entry) => entry.tag.taxonomy.name == "Instrument"
    //     )
    // )

    // const genreTags = $derived(() =>
    //     dataStore.tag_summary.filter(
    //         (entry) => entry.tag.taxonomy.name == "Genre"
    //     )
    // )

    $effect(() => {
        if (
            queryStore.sort in
            ["random", "popularity", "relevance", "recency", "pack_popularity"]
        ) {
            queryStore.order = "DESC"
        }
    })

    storeCallbacks.onbeforedataupdate = () => {
        viewportScrollTop = 0
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
    }

    storeCallbacks.onBrowseModeListReset = () => {
        viewportScrollTop = 0
        if (viewportRef) viewportRef.scrollTop = 0
        const first = dataStore.sampleAssets[0]
        if (first) {
            globalAudio.selectSampleAsset(first, false)
        }
    }

    storeCallbacks.onbeforetagsupdate = () => {
        tagsDrawerRef.style.height = `${tagsContainerRef.offsetHeight}px`
    }

    let expandTags = $state(false)
    let bulkDownloadConfirmOpen = $state(false)
    let samplePackSyncOpen = $state(false)
    let mirrorBackfillOpen = $state(false)

    let viewportRef = $state<HTMLElement>(null!)
    let tagsContainerRef = $state<HTMLElement>(null!)
    let tagsDrawerRef = $state<HTMLElement>(null!)
    let searchInputRef = $state<HTMLInputElement>(null!)
    let libraryLoadSentinel = $state<HTMLElement>(null!)
    let online = $state(
        typeof navigator !== "undefined" ? navigator.onLine : true
    )
    let initialFetchStarted = false
    let pageMounted = $state(false)
    let loadedLibraryDir: string | null | undefined = undefined
    const LOCAL_ROW_HEIGHT = 57
    const LOCAL_OVERSCAN = 12
    let viewportScrollTop = $state(0)
    let viewportHeight = $state(600)
    const localVisibleStart = $derived(
        Math.max(0, Math.floor(viewportScrollTop / LOCAL_ROW_HEIGHT) - LOCAL_OVERSCAN)
    )
    const localVisibleEnd = $derived(
        Math.min(
            dataStore.sampleAssets.length,
            Math.ceil((viewportScrollTop + viewportHeight) / LOCAL_ROW_HEIGHT) +
                LOCAL_OVERSCAN
        )
    )
    const visibleSampleAssets = $derived(
        browseStore.mode === "library"
            ? dataStore.sampleAssets.slice(localVisibleStart, localVisibleEnd)
            : dataStore.sampleAssets
    )

    $effect(() => {
        if (!pageMounted || !configLoadState.loaded) return

        const libraryDir = getConnectedLibraryDir()
        if (!initialFetchStarted) {
            initialFetchStarted = true
            loadedLibraryDir = libraryDir
            fetchAssets()
            return
        }

        if (
            browseStore.mode === "library" &&
            libraryDir !== loadedLibraryDir
        ) {
            loadedLibraryDir = libraryDir
            resetAssetList()
            fetchAssets()
        }
    })

    const setBrowseMode = (mode: "splice" | "library") => {
        switchBrowseMode(mode)
    }

    const selectedSampleIndex = $derived(
        dataStore.sampleAssets.findIndex(
            (sampleAsset) => sampleAsset.uuid == globalAudio.currentAsset?.uuid
        )
    )

    const updateSort = (newSort: AssetSortType) => {
        if (queryStore.sort == newSort) {
            if (queryStore.order == "DESC") {
                queryStore.order = "ASC"
            } else {
                queryStore.sort = DEFAULT_SORT
            }
        } else {
            queryStore.sort = newSort
            queryStore.order = "DESC"
        }
        resetAssetList()
        fetchAssets()
    }

    const onSortSelect = (newSort: string) => {
        if (queryStore.sort !== newSort) {
            queryStore.order = "DESC"
        }
        queryStore.sort = newSort as AssetSortType
        reloadFilteredAssets()
    }

    const reloadFilteredAssets = () => {
        resetAssetList()
        fetchAssets()
    }

    const gotoPrev = () => {
        const currentIndex = dataStore.sampleAssets.findIndex(
            (asset) => asset.uuid === globalAudio.currentAsset?.uuid
        )
        if (currentIndex > 0) {
            const sampleAsset = dataStore.sampleAssets[currentIndex - 1]
            globalAudio.playSampleAsset(sampleAsset)
            const entryEl = document.getElementById(
                `sample-list-entry-${sampleAsset.uuid}`
            )
            if (entryEl)
                entryEl.scrollIntoView({ behavior: "smooth", block: "nearest" })
        }
    }

    const gotoNext = () => {
        const currentIndex = dataStore.sampleAssets.findIndex(
            (asset) => asset.uuid === globalAudio.currentAsset?.uuid
        )
        if (
            currentIndex !== -1 &&
            currentIndex + 1 < dataStore.sampleAssets.length
        ) {
            const sampleAsset = dataStore.sampleAssets[currentIndex + 1]
            globalAudio.playSampleAsset(sampleAsset)
            const entryEl = document.getElementById(
                `sample-list-entry-${sampleAsset.uuid}`
            )
            if (entryEl)
                entryEl.scrollIntoView({ behavior: "smooth", block: "nearest" })
        } else if (
            currentIndex === dataStore.sampleAssets.length - 1 &&
            browseStore.mode === "library" &&
            dataStore.has_more &&
            !loading.assets
        ) {
            fetchAssets()
        }
    }

    // const updateTagSummary = () =>
    //     dataStore.tag_summary.sort(
    //         (a: any, b: any) =>
    //             Number(dataStore.tags.includes(b.tag.uuid)) -
    //             Number(dataStore.tags.includes(a.tag.uuid))
    //     )

    onMount(() => {
        const onOnline = () => (online = true)
        const onOffline = () => (online = false)
        const onViewportScroll = () => {
            viewportScrollTop = viewportRef.scrollTop
            viewportHeight = viewportRef.clientHeight
            if (loading.assets) return
            if (browseStore.mode === "library") return
            const preloadDistance = viewportRef.clientHeight
            const nearBottom =
                viewportRef.scrollTop + viewportRef.clientHeight >=
                viewportRef.scrollHeight - preloadDistance
            if (!nearBottom || !dataStore.has_more) return

            if (browseStore.mode === "splice") queryStore.page += 1
            fetchAssets()
        }
        window.addEventListener("online", onOnline)
        window.addEventListener("offline", onOffline)
        viewportRef.addEventListener("scroll", onViewportScroll, {
            passive: true,
        })
        const viewportResize = new ResizeObserver(() => {
            viewportHeight = viewportRef.clientHeight
        })
        viewportResize.observe(viewportRef)
        viewportHeight = viewportRef.clientHeight
        const libraryLoader = new IntersectionObserver(
            (entries) => {
                if (
                    entries.some((entry) => entry.isIntersecting) &&
                    browseStore.mode === "library" &&
                    dataStore.has_more &&
                    !loading.assets
                ) {
                    fetchAssets()
                }
            },
            { root: viewportRef, rootMargin: "200% 0px" }
        )
        libraryLoader.observe(libraryLoadSentinel)

        searchInputRef.focus()
        pageMounted = true

        return () => {
            window.removeEventListener("online", onOnline)
            window.removeEventListener("offline", onOffline)
            viewportRef.removeEventListener("scroll", onViewportScroll)
            viewportResize.disconnect()
            libraryLoader.disconnect()
        }
    })
</script>

<main class="flex flex-col size-full">
    <div class="flex flex-col p-4 gap-4">
        {#if !online}
            <p class="text-sm text-muted-foreground rounded-md border px-3 py-2">
                You're offline. Splice search may fail; use
                <strong>My library</strong> to browse downloaded samples.
            </p>
        {/if}
        <div class="flex gap-2 items-center">
            <Button
                variant={browseStore.mode === "splice" ? "default" : "outline"}
                size="sm"
                onclick={() => setBrowseMode("splice")}>Splice</Button
            >
            <Button
                variant={browseStore.mode === "library" ? "default" : "outline"}
                size="sm"
                onclick={() => setBrowseMode("library")}>My library</Button
            >
            {#if browseStore.mode === "library"}
                <Button
                    variant={browseStore.libraryFavoritesOnly
                        ? "default"
                        : "outline"}
                    size="sm"
                    onclick={() => {
                        browseStore.libraryFavoritesOnly =
                            !browseStore.libraryFavoritesOnly
                        resetAssetList()
                        fetchAssets()
                    }}>Favorites only</Button
                >
            {/if}
        </div>
        <div class="flex gap-4 justify-between items-center">
            <SettingsDialog />
            <SearchInput
                bind:value={queryStore.query}
                onsubmit={reloadFilteredAssets}
                mode={browseStore.mode}
                class="flex-grow"
                bind:inputRef={searchInputRef}
            />
            <PackSelect
                mode={browseStore.mode}
                bind:pack_uuid={queryStore.pack_uuid}
                bind:pack_label={queryStore.pack_label}
                bind:pack_folder_name={queryStore.pack_folder_name}
                onselect={reloadFilteredAssets}
            />
            <KeySelect
                bind:key={queryStore.key}
                bind:chord_type={queryStore.chord_type}
                onselect={reloadFilteredAssets}
            />
            <BpmSelect
                bind:bpm={queryStore.bpm}
                bind:min_bpm={queryStore.min_bpm}
                bind:max_bpm={queryStore.max_bpm}
                onsubmit={reloadFilteredAssets}
            />
            <AssetCategorySelect
                bind:asset_category_slug={queryStore.asset_category_slug}
                onselect={reloadFilteredAssets}
            />
        </div>

        <div
            class="transition-[height] ease-in-out overflow-clip"
            bind:this={tagsDrawerRef}
        >
            <div
                class="flex justify-between gap-2"
                bind:this={tagsContainerRef}
            >
                <div
                    class={cn(
                        "min-w-0 relative",
                        !expandTags &&
                            "pr-4 after:content-[''] after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-gradient-to-r after:from-transparent after:to-background after:pointer-events-none"
                    )}
                >
                    <div
                        class={cn(
                            "flex text-nowrap gap-1 overflow-clip flex-shrink",
                            expandTags && "flex-wrap"
                        )}
                    >
                        {#each dataStore.tag_summary as tag}
                            {@const active = dataStore.tags.includes(
                                tag.tag.uuid
                            )}
                            <TagBadge
                                label={tag.tag.label}
                                count={tag.count}
                                {active}
                                onclick={() => {
                                    if (active) {
                                        dataStore.tags.splice(
                                            dataStore.tags.indexOf(
                                                tag.tag.uuid
                                            ),
                                            1
                                        )
                                    } else {
                                        dataStore.tags.push(tag.tag.uuid)
                                    }
                                    // updateTagSummary()
                                    reloadFilteredAssets()
                                }}
                            />
                        {/each}
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="icon"
                    onclick={() => {
                        expandTags = !expandTags
                        tick().then(() => {
                            tagsDrawerRef.style.height =
                                tagsContainerRef.offsetHeight + "px"
                        })
                    }}
                    class="shrink-0 h-6 px-5 text-muted-foreground"
                >
                    <ChevronDown
                        size="18"
                        class={cn(
                            "transition-transform ease-in-out",
                            expandTags ? "rotate-[-180deg]" : ""
                        )}
                    /></Button
                >
            </div>
        </div>

        <div class="flex justify-between items-end gap-2">
            <div class="text-muted-foreground text-xs flex-grow">
                {#if browseStore.mode === "splice"}
                    {dataStore.total_records.toLocaleString()} results
                {:else}
                    {#if dataStore.total_exact}
                        {dataStore.total_records.toLocaleString()} results
                    {:else if dataStore.total_counting}
                        Counting results…
                    {:else}
                        Local results
                    {/if}
                {/if}
            </div>
            {#if browseStore.mode === "splice"}
                <Button
                    variant="outline"
                    size="icon"
                    class="h-9 w-9 shrink-0"
                    title="Local mirror backfill"
                    disabled={(bulkDownloadState.running &&
                        !mirrorBackfillState.running) ||
                        packSyncManager.active}
                    onclick={() => {
                        mirrorBackfillOpen = true
                    }}
                >
                    {#if mirrorBackfillState.running}
                        <LoaderCircle class="size-4 animate-spin" />
                    {:else}
                        <Database class="size-4" />
                    {/if}
                </Button>
                <Button
                    variant="outline"
                    size="icon"
                    class="h-9 w-9 shrink-0"
                    title="Sample pack sync"
                    disabled={bulkDownloadState.running &&
                        !packSyncManager.active ||
                        mirrorBackfillState.running}
                    onclick={() => {
                        samplePackSyncOpen = true
                    }}
                >
                    <Package class="size-4" />
                </Button>
                <Button
                    variant="outline"
                    class="h-9 shrink-0 gap-1.5 px-2.5 max-w-[11rem]"
                    disabled={bulkDownloadState.running &&
                    !packSyncManager.active
                        ? false
                        : dataStore.total_records === 0 ||
                          packSyncManager.active ||
                          mirrorBackfillState.running ||
                          getActiveDownloadSessionTag() === "pack-sync"}
                    onclick={() => {
                        if (
                            bulkDownloadState.running &&
                            !packSyncManager.active
                        ) {
                            requestStopBulkDownload()
                            return
                        }
                        if (
                            packSyncManager.active ||
                            getActiveDownloadSessionTag() === "pack-sync"
                        ) {
                            toast("Stop pack sync before Download all.", {
                                variant: "info",
                            })
                            return
                        }
                        if (mirrorBackfillState.running) {
                            toast("Pause mirror backfill before Download all.", {
                                variant: "info",
                            })
                            return
                        }
                        bulkDownloadConfirmOpen = true
                    }}
                >
                    {#if bulkDownloadState.running && !packSyncManager.active}
                        <LoaderCircle class="size-4 animate-spin shrink-0" />
                        <span class="text-xs tabular-nums truncate">
                            {#if bulkDownloadState.phase === "listing"}
                                {#if bulkDownloadState.total > 0}
                                    {bulkDownloadState.total.toLocaleString()}
                                {:else if bulkDownloadState.reportedTotal > 0}
                                    {bulkDownloadState.scanned.toLocaleString()}/{bulkDownloadState.reportedTotal.toLocaleString()}
                                {:else}
                                    {bulkDownloadState.scanned.toLocaleString()}
                                {/if}
                            {:else}
                                {bulkDownloadState.completed.toLocaleString()}/{bulkDownloadState.total.toLocaleString()}
                            {/if}
                        </span>
                    {:else}
                        <Download class="size-4" />
                        <span class="text-xs">Download all</span>
                    {/if}
                </Button>
                <Button
                    variant="outline"
                    size="icon"
                    disabled={bulkDownloadState.running}
                    onclick={() => {
                        queryStore.random_seed = randomSeed()
                        queryStore.sort = "random"
                        fetchAssets()
                    }}
                >
                    <Shuffle />
                </Button>
            {/if}
            <SortSelect
                bind:sort={queryStore.sort}
                mode={browseStore.mode}
                onselect={onSortSelect}
                order={queryStore.order}
            />
        </div>

        <div class="flex flex-col gap-2">
            <Separator />
            <div
                class="grid gap-2 items-center overflow-clip px-2"
                style:grid-template-columns={SAMPLE_LIST_GRID}
            >
                {#if browseStore.mode === "library"}
                    <SortHeader
                        value="pack_name"
                        label="Pack"
                        sort={queryStore.sort}
                        order={queryStore.order}
                        onsort={updateSort}
                        class="min-w-0"
                    />
                {:else}
                    <div
                        class="min-w-0 text-xs text-muted-foreground"
                    >
                        Pack
                    </div>
                {/if}
                <div
                    class="min-w-0 text-xs text-muted-foreground"
                ></div>
                <SortHeader
                    value="name"
                    label="Filename"
                    sort={queryStore.sort}
                    order={queryStore.order}
                    onsort={updateSort}
                    class="min-w-0"
                />
                <div class="min-w-0 md:block hidden"></div>
                <SortHeader
                    value="duration"
                    label="Time"
                    sort={queryStore.sort}
                    order={queryStore.order}
                    onsort={updateSort}
                    class="min-w-0"
                />
                <SortHeader
                    value="key"
                    label="Key"
                    sort={queryStore.sort}
                    order={queryStore.order}
                    onsort={updateSort}
                    class="min-w-0"
                />
                <SortHeader
                    value="bpm"
                    label="BPM"
                    sort={queryStore.sort}
                    order={queryStore.order}
                    onsort={updateSort}
                    class="min-w-0"
                />
                <div></div>
                <div></div>
            </div>
            <ProgressLoading
                loading={(loading.assets &&
                    (browseStore.mode === "splice" ||
                        dataStore.sampleAssets.length === 0)) ||
                    (browseStore.mode === "splice" &&
                        loading.waveformsCount > 0)}
            />
        </div>
    </div>
    <ScrollArea
        class="px-4 flex-grow before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-4 before:bg-gradient-to-t before:from-transparent before:to-background before:pointer-events-none after:content-[''] after:absolute after:inset-x-0 after:bottom-0 after:h-4 after:bg-gradient-to-b after:from-transparent after:to-background after:pointer-events-none"
        bind:viewportRef
        onkeydown={(e) => {
            switch (e.key) {
                case "ArrowUp":
                    e.preventDefault()
                    gotoPrev()
                    break
                case "ArrowDown":
                    e.preventDefault()
                    gotoNext()
                    break
                case "ArrowLeft":
                    e.preventDefault()
                    gotoPrev()
                    break
                case "ArrowRight":
                    e.preventDefault()
                    gotoNext()
                    break
                case " ":
                    e.preventDefault()
                    globalAudio.togglePlay()
                    break
            }
        }}
    >
        <div class="flex flex-col py-2 min-h-full">
            {#if browseStore.mode === "library" && localVisibleStart > 0}
                <div style={`height: ${localVisibleStart * LOCAL_ROW_HEIGHT}px`}></div>
            {/if}
            {#each visibleSampleAssets as sampleAsset, visibleIndex (sampleAsset.uuid)}
                {@const index = browseStore.mode === "library"
                    ? localVisibleStart + visibleIndex
                    : visibleIndex}
                {@const selected =
                    globalAudio.currentAsset?.uuid == sampleAsset.uuid}
                <div style={browseStore.mode === "library" ? `height: ${LOCAL_ROW_HEIGHT}px` : undefined}>
                    <SampleListEntry
                        {sampleAsset}
                        {selected}
                        playing={selected && !globalAudio.paused}
                    />
                    {#if index < dataStore.sampleAssets.length - 1}
                        <div
                            class={selected || index + 1 == selectedSampleIndex
                                ? "px-2"
                                : ""}
                        >
                            <Separator />
                        </div>
                    {/if}
                </div>
            {:else}
                {#if dataStore.sampleAssets.length === 0}
                    <div
                        class="flex flex-col gap-2 justify-center items-center size-full text-muted-foreground"
                    >
                        {#if loading.fetchError}
                            <Ghost size="48" />
                            <p class="font-bold text-xl">Something went wrong :/</p>
                            <p class="text-sm">Couldn't load any samples</p>
                            <Button onclick={fetchAssets}>Retry</Button>
                        {:else if browseStore.mode === "library" &&
                            !isSamplesDirValid()}
                            <Search size="48" />
                            <p class="font-bold text-xl">Samples folder required</p>
                            <p class="text-sm">
                                Set a valid Samples Directory in Settings to use your
                                library.
                            </p>
                        {:else if loading.beforeFirstLoad}
                            <Smile size="48" />
                            <p class="font-bold text-xl">Hey there!</p>
                            <p class="text-sm">Make some cool music, will ya?</p>
                        {:else}
                            <Search size="48" />
                            <p class="font-bold text-xl">No results</p>
                            <p class="text-sm">Try different keywords</p>
                        {/if}
                    </div>
                {/if}
            {/each}
            {#if browseStore.mode === "library" && localVisibleEnd < dataStore.sampleAssets.length}
                <div style={`height: ${(dataStore.sampleAssets.length - localVisibleEnd) * LOCAL_ROW_HEIGHT}px`}></div>
            {/if}
            <div
                bind:this={libraryLoadSentinel}
                class="h-px shrink-0"
                aria-hidden="true"
            ></div>
            {#if loading.fetchError && dataStore.sampleAssets.length > 0}
                <div
                    class="flex flex-col py-8 gap-2 justify-center items-center text-muted-foreground"
                >
                    <Ghost size="48" />
                    <p class="font-bold text-xl">Something went wrong :/</p>
                    <p class="text-sm">Couldn't load any more samples</p>
                    <Button onclick={fetchAssets}>Retry</Button>
                </div>
            {/if}
        </div>
    </ScrollArea>
    <AudioPlayer onprev={gotoPrev} onnext={gotoNext} />

    <SamplePackSyncDialog bind:open={samplePackSyncOpen} />
    <MirrorBackfillDialog bind:open={mirrorBackfillOpen} />

    <Dialog.Root bind:open={bulkDownloadConfirmOpen}>
        <Dialog.Content>
            <Dialog.Header>
                <Dialog.Title>Download all results?</Dialog.Title>
                <Dialog.Description>
                    Up to {dataStore.total_records.toLocaleString()} samples from
                    this search will be downloaded. Items already in your library
                    are skipped.
                </Dialog.Description>
            </Dialog.Header>
            <Dialog.Footer>
                <Button
                    variant="outline"
                    onclick={() => {
                        bulkDownloadConfirmOpen = false
                    }}>Cancel</Button
                >
                <Button
                    onclick={() => {
                        bulkDownloadConfirmOpen = false
                        void downloadAllSpliceResults()
                    }}>Download</Button
                >
            </Dialog.Footer>
        </Dialog.Content>
    </Dialog.Root>
</main>
