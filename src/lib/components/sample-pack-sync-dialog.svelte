<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog"
    import Button from "$lib/components/ui/button/button.svelte"
    import Label from "$lib/components/ui/label/label.svelte"
    import Switch from "$lib/components/ui/switch/switch.svelte"
    import LoaderCircle from "lucide-svelte/icons/loader-circle"
    import Package from "lucide-svelte/icons/package"
    import Download from "lucide-svelte/icons/download"
    import Search from "lucide-svelte/icons/search"
    import Check from "lucide-svelte/icons/check"
    import type { PackAsset } from "$lib/splice/types"
    import {
        applyPackFilter,
        dataStore,
        fetchSplicePacksPage,
        packDisplayName,
    } from "$lib/shared/store.svelte"
    import {
        enqueuePackSync,
        enqueueSinglePackSync,
        getPackSyncRow,
        isPackSyncCompleteForPack,
        packCachedCount,
        packListableTotal,
        packSyncManager,
        refreshPackMirrorStats,
        requestStopPackSync,
    } from "$lib/shared/pack-sync.svelte"
    import { getBulkDownloadConcurrency } from "$lib/shared/bulk-download-health"
    import {
        packMirrorTargetTotal,
        splicePackSampleTotal,
    } from "$lib/splice/pack-stats"
    import {
        buildPackPopularityScopeKey,
        fetchPackPopularityScores,
        sortPacksByLocalPopularity,
        type PackPopularityScore,
    } from "$lib/splice/pack-popularity"
    import {
        isRemoteUrl,
        resolvePackCoverRemoteUrl,
    } from "$lib/shared/pack-cover"
    import { cn } from "$lib/utils"

    let { open = $bindable(false) }: { open: boolean } = $props()

    let packs = $state<PackAsset[]>([])
    let cachedByUuid = $state<Record<string, number>>({})
    let listableByUuid = $state<Record<string, number | null>>({})
    let loading = $state(false)
    let loadError = $state<string | null>(null)
    let page = $state(1)
    let totalPages = $state(1)

    let matchActiveTags = $state(true)
    let showComplete = $state(false)
    let popularityScores = $state<Record<string, PackPopularityScore>>({})

    const activeTagCount = $derived(dataStore.tags.length)

    function packTotal(pack: PackAsset) {
        const row = getPackSyncRow(pack.uuid)
        const listable = packListableTotal(pack.uuid, listableByUuid)
        return packMirrorTargetTotal(pack, listable ?? row?.listableTotal)
    }

    function packIsComplete(pack: PackAsset) {
        const row = getPackSyncRow(pack.uuid)
        return isPackSyncCompleteForPack(
            pack,
            packCachedCount(pack.uuid, cachedByUuid),
            row
        )
    }

    const visiblePacks = $derived.by(() => {
        void packSyncManager.rows
        return packs.filter((pack) => {
            if (showComplete) return true
            return !packIsComplete(pack)
        })
    })

    const incompleteVisible = $derived.by(() => {
        void packSyncManager.rows
        return visiblePacks.filter((p) => !packIsComplete(p))
    })

    const syncConcurrencyLine = $derived.by(() => {
        void packSyncManager.sessionSaved
        if (!packSyncManager.active) return null
        return `${getBulkDownloadConcurrency()} parallel`
    })

    function tagsForQuery() {
        return matchActiveTags ? [...dataStore.tags] : []
    }

    async function loadPage(nextPage: number, replace: boolean) {
        loading = true
        loadError = null
        try {
            const result = await fetchSplicePacksPage({
                page: nextPage,
                tags: tagsForQuery(),
                sort: "popularity",
                order: "DESC",
            })
            if (!result) {
                loadError = "Could not load packs."
                if (replace) packs = []
                return
            }
            page = result.currentPage
            totalPages = result.totalPages
            const nextPacks = replace
                ? result.items
                : [...packs, ...result.items]
            const mirror = await refreshPackMirrorStats(result.items)
            const nextCached = { ...cachedByUuid }
            const nextListable = { ...listableByUuid }
            for (const [uuid, s] of Object.entries(mirror)) {
                nextCached[uuid] = s.cached
                nextListable[uuid] = s.listableTotal
            }
            cachedByUuid = nextCached
            listableByUuid = nextListable
            const scopeKey = buildPackPopularityScopeKey(tagsForQuery())
            const scores = await fetchPackPopularityScores(
                scopeKey,
                nextPacks.map((p) => p.uuid)
            )
            popularityScores = { ...popularityScores, ...scores }
            packs = sortPacksByLocalPopularity(nextPacks, {
                ...popularityScores,
                ...scores,
            })
        } catch (e) {
            loadError =
                e instanceof Error ? e.message : "Could not load packs."
            if (replace) packs = []
        } finally {
            loading = false
        }
    }

    let listPrimed = $state(false)

    $effect(() => {
        if (!open) {
            listPrimed = false
            return
        }
        void matchActiveTags
        void activeTagCount
        const delay = listPrimed ? 280 : 0
        listPrimed = true
        const handle = setTimeout(() => {
            void loadPage(1, true)
        }, delay)
        return () => clearTimeout(handle)
    })

    $effect(() => {
        if (!open || !packs.length) return
        void packSyncManager.sessionSaved
        const scopeKey = buildPackPopularityScopeKey(tagsForQuery())
        void fetchPackPopularityScores(
            scopeKey,
            packs.map((p) => p.uuid)
        ).then((scores) => {
            if (Object.keys(scores).length > 0) {
                popularityScores = { ...popularityScores, ...scores }
                packs = sortPacksByLocalPopularity(packs, {
                    ...popularityScores,
                    ...scores,
                })
            }
        })
    })

    function packCoverUrl(pack: PackAsset) {
        const url = resolvePackCoverRemoteUrl(pack)
        return isRemoteUrl(url) ? url! : ""
    }

    function browsePack(pack: PackAsset) {
        applyPackFilter(pack)
        open = false
    }

    function rowStatus(pack: PackAsset) {
        const row = getPackSyncRow(pack.uuid)
        const cached = row?.cached ?? cachedByUuid[pack.uuid] ?? 0
        const total = packTotal(pack)

        if (row?.phase === "queued") return "Queued"
        if (row?.phase === "listing") {
            if (total) return `Scanning ${row.listed.toLocaleString()}/${total.toLocaleString()}`
            return `Scanning ${row.listed.toLocaleString()}`
        }
        if (row?.phase === "downloading") {
            return `Downloading ${row.batchDone.toLocaleString()}/${row.batchTotal.toLocaleString()}`
        }
        if (row?.phase === "done") {
            if (row.failedRun > 0) {
                const hint = row.lastFailure ? ` · ${row.lastFailure}` : ""
                return `Done · ${row.failedRun.toLocaleString()} failed${hint}`
            }
            const target = packTotal(pack)
            if (
                target != null &&
                target > 0 &&
                cached >= target
            ) {
                return "Synced"
            }
            if (
                target == null &&
                row.syncListingComplete &&
                row.listedInLibrary >= row.listed
            ) {
                return "Synced"
            }
            if (target != null && cached < target) {
                return `${cached.toLocaleString()} / ${target.toLocaleString()}`
            }
            return "Done"
        }
        if (row?.phase === "cancelled") return "Stopped"
        if (row?.phase === "error") return row.error ?? "Failed"

        const pop = popularityScores[pack.uuid]
        if (pop?.bestRank != null && total != null) {
            return `#${pop.bestRank} · ${cached.toLocaleString()} / ${total.toLocaleString()}`
        }
        if (total != null) {
            return `${cached.toLocaleString()} / ${total.toLocaleString()}`
        }
        if (cached > 0) return `${cached.toLocaleString()} in library`
        return ""
    }

    function isRowActive(pack: PackAsset) {
        if (packSyncManager.currentPackUuid === pack.uuid) return true
        const phase = getPackSyncRow(pack.uuid)?.phase
        return (
            phase === "queued" ||
            phase === "listing" ||
            phase === "downloading"
        )
    }

    function syncEnqueueOptions() {
        return { matchBrowseTags: matchActiveTags }
    }

    function syncPack(pack: PackAsset) {
        const cached = cachedByUuid[pack.uuid] ?? 0
        enqueueSinglePackSync(pack, cached, syncEnqueueOptions())
    }

    function syncAllVisible() {
        enqueuePackSync(incompleteVisible, cachedByUuid, syncEnqueueOptions())
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content
        class="max-w-2xl gap-0 p-0 overflow-hidden max-h-[90vh] !flex flex-col"
    >
        <div class="p-5 border-b shrink-0">
            <Dialog.Header class="text-left space-y-1">
                <Dialog.Title class="flex items-center gap-2 text-lg">
                    <Package class="size-5" />
                    Sample pack sync
                </Dialog.Title>
            </Dialog.Header>

            <div
                class="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
            >
                <div class="flex items-center gap-2">
                    <Switch id="match-tags" bind:checked={matchActiveTags} />
                    <Label for="match-tags" class="font-normal"
                        >Match browse tags</Label
                    >
                </div>
                <div class="flex items-center gap-2">
                    <Switch id="show-complete" bind:checked={showComplete} />
                    <Label for="show-complete" class="font-normal"
                        >Show complete packs</Label
                    >
                </div>
            </div>

            {#if packSyncManager.active || packSyncManager.queue.length > 0}
                <div
                    class="mt-4 rounded-lg border px-3 py-2 flex items-center justify-between gap-3 bg-muted/30"
                >
                    <div class="flex items-center gap-2 min-w-0 text-sm">
                        <LoaderCircle class="size-4 shrink-0 animate-spin" />
                        <span class="tabular-nums truncate">
                            {packSyncManager.sessionSaved.toLocaleString()} saved
                            {#if packSyncManager.sessionFailed > 0}
                                · {packSyncManager.sessionFailed.toLocaleString()}
                                failed
                            {/if}
                            {#if packSyncManager.queue.length > 0}
                                · {packSyncManager.queue.length} queued
                            {/if}
                            {#if syncConcurrencyLine}
                                · {syncConcurrencyLine}
                            {/if}
                        </span>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={() => requestStopPackSync()}
                    >
                        Stop
                    </Button>
                </div>
            {/if}
        </div>

        <div
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            role="region"
            aria-label="Pack list"
        >
            <div class="p-3 flex flex-col gap-1.5">
                {#if loadError}
                    <div
                        class="flex flex-col items-center gap-2 py-12 text-muted-foreground"
                    >
                        <p class="text-sm">{loadError}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            onclick={() => loadPage(1, true)}>Retry</Button
                        >
                    </div>
                {:else if loading && packs.length === 0}
                    <div
                        class="flex items-center justify-center gap-2 py-16 text-muted-foreground"
                    >
                        <LoaderCircle class="size-5 animate-spin" />
                        <span class="text-sm">Loading…</span>
                    </div>
                {:else if visiblePacks.length === 0}
                    <div
                        class="flex flex-col items-center gap-2 py-12 text-muted-foreground text-center px-4"
                    >
                        <Search class="size-8 opacity-60" />
                        <p class="text-sm">
                            {#if packs.length > 0 && !showComplete}
                                All loaded packs are fully synced.
                                Toggle “Show complete packs” to see them.
                            {:else}
                                No packs found.
                            {/if}
                        </p>
                    </div>
                {:else}
                    {#each visiblePacks as pack (pack.uuid)}
                        {@const cover = packCoverUrl(pack)}
                        {@const title = packDisplayName(pack.name)}
                        {@const cached = packCachedCount(
                            pack.uuid,
                            cachedByUuid
                        )}
                        {@const complete = packIsComplete(pack)}
                        {@const status = rowStatus(pack)}
                        {@const active = isRowActive(pack)}
                        <div
                            class={cn(
                                "flex gap-3 rounded-lg border p-2.5 items-center",
                                active && "border-primary/40 bg-muted/25"
                            )}
                        >
                            {#if cover}
                                <img
                                    src={cover}
                                    alt=""
                                    class="size-11 rounded object-cover shrink-0 bg-muted"
                                />
                            {:else}
                                <div
                                    class="size-11 rounded bg-muted shrink-0"
                                ></div>
                            {/if}
                            <div class="min-w-0 flex-1">
                                <p class="text-sm font-medium truncate">
                                    {title}
                                </p>
                                <p
                                    class="text-xs text-muted-foreground truncate tabular-nums"
                                >
                                    {#if status}
                                        {status}
                                    {:else if pack.provider?.name}
                                        {pack.provider.name}
                                    {/if}
                                </p>
                                {#if active}
                                    {@const row = getPackSyncRow(pack.uuid)}
                                    {#if row && row.phase === "downloading" && row.batchTotal > 0}
                                        <div
                                            class="mt-1.5 h-1 rounded-full bg-muted overflow-hidden"
                                        >
                                            <div
                                                class="h-full bg-primary transition-[width]"
                                                style="width: {Math.min(
                                                    100,
                                                    (row.batchDone /
                                                        row.batchTotal) *
                                                        100
                                                )}%"
                                            ></div>
                                        </div>
                                    {/if}
                                {/if}
                            </div>
                            <div class="flex gap-1 shrink-0 items-center">
                                {#if complete && !active}
                                    <Check
                                        class="size-4 text-muted-foreground mr-1"
                                    />
                                {/if}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    class="h-8 px-2"
                                    onclick={() => browsePack(pack)}
                                >
                                    Browse
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-8 px-2"
                                    disabled={complete || active}
                                    onclick={() => syncPack(pack)}
                                >
                                    {#if active}
                                        <LoaderCircle
                                            class="size-3.5 animate-spin"
                                        />
                                    {:else}
                                        <Download class="size-3.5" />
                                    {/if}
                                </Button>
                            </div>
                        </div>
                    {/each}
                    {#if page < totalPages}
                        <Button
                            variant="ghost"
                            class="w-full mt-1"
                            disabled={loading}
                            onclick={() => loadPage(page + 1, false)}
                        >
                            {#if loading}
                                <LoaderCircle
                                    class="size-4 animate-spin mr-2"
                                />
                            {/if}
                            Load more
                        </Button>
                    {/if}
                {/if}
            </div>
        </div>

        <Dialog.Footer class="border-t p-4 shrink-0 gap-2 sm:justify-end">
            <Button variant="outline" onclick={() => (open = false)}
                >Close</Button
            >
            <Button
                class="gap-1.5"
                disabled={incompleteVisible.length === 0}
                onclick={() => syncAllVisible()}
            >
                <Download class="size-4" />
                Sync all
            </Button>
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
