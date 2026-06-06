<script lang="ts">
    import Check from "lucide-svelte/icons/check"
    import * as Command from "$lib/components/ui/command/index.js"
    import * as Popover from "$lib/components/ui/popover/index.js"
    import { Button } from "$lib/components/ui/button/index.js"
    import { cn } from "$lib/utils.js"
    import { tick } from "svelte"
    import ChevronDown from "lucide-svelte/icons/chevron-down"
    import { PacksSearch, querySplice } from "$lib/splice/api"
    import type { PackAsset } from "$lib/splice/types"
    import type { BrowseMode } from "$lib/library/api"
    import { libraryListPacks } from "$lib/library/api"
    import { config, isSamplesDirValid } from "$lib/shared/config.svelte"
    import {
        isRemoteUrl,
        localPackCoverAssetUrl,
        resolvePackCoverRemoteUrl,
    } from "$lib/shared/pack-cover"

    type PackOption = {
        uuid: string
        name: string
        displayName: string
    }

    let {
        pack_uuid = $bindable(),
        pack_label = $bindable(),
        pack_folder_name = $bindable(),
        mode,
        onselect,
    }: {
        pack_uuid: string | null
        pack_label: string | null
        pack_folder_name: string | null
        mode: BrowseMode
        onselect: () => void
    } = $props()

    let open = $state(false)
    let triggerRef = $state<HTMLButtonElement>(null!)
    let search = $state("")
    let loading = $state(false)
    let options = $state<PackOption[]>([])
    let coverByUuid = $state<Record<string, string>>({})

    function displayPackName(name: string) {
        return name.split("/").slice(-1)[0] || name
    }

    async function resolveCovers(items: PackOption[], packs?: PackAsset[]) {
        const next: Record<string, string> = { ...coverByUuid }
        for (let i = 0; i < items.length; i++) {
            const opt = items[i]
            if (next[opt.uuid]) continue
            if (mode === "library") {
                const local = await localPackCoverAssetUrl(opt.name)
                if (local) next[opt.uuid] = local
                continue
            }
            const pack = packs?.[i]
            const remote = pack ? resolvePackCoverRemoteUrl(pack) : undefined
            if (remote && isRemoteUrl(remote)) next[opt.uuid] = remote
        }
        coverByUuid = next
    }

    async function loadPacks(term: string) {
        loading = true
        try {
            if (mode === "library") {
                if (!isSamplesDirValid() || !config.samples_dir) {
                    options = []
                    return
                }
                const rows = await libraryListPacks(config.samples_dir, term)
                const mapped = rows.map((r) => ({
                    uuid: r.uuid,
                    name: r.name,
                    displayName: displayPackName(r.name),
                }))
                options = mapped
                await resolveCovers(mapped)
                return
            }
            const response = await querySplice(PacksSearch, {
                query: term.trim() || null,
                page: 1,
                limit: 50,
                tags: [],
            })
            const items = (response as { data?: { assetsSearch?: { items: PackAsset[] } } })
                ?.data?.assetsSearch?.items
            if (!items) {
                options = []
                return
            }
            const mapped = items.map((p) => ({
                uuid: p.uuid,
                name: p.name,
                displayName: displayPackName(p.name),
            }))
            options = mapped
            await resolveCovers(mapped, items)
        } finally {
            loading = false
        }
    }

    $effect(() => {
        if (!open) return
        const term = search
        const handle = setTimeout(() => {
            void loadPacks(term)
        }, 200)
        return () => clearTimeout(handle)
    })

    function closeAndFocusTrigger() {
        open = false
        tick().then(() => {
            triggerRef.focus()
        })
    }

    function selectPack(opt: PackOption | null) {
        if (!opt) {
            pack_uuid = null
            pack_label = null
            pack_folder_name = null
        } else {
            pack_uuid = opt.uuid
            pack_label = opt.displayName
            pack_folder_name = opt.name
        }
        closeAndFocusTrigger()
        onselect()
    }

    const triggerCover = $derived(
        pack_uuid ? coverByUuid[pack_uuid] : undefined
    )

    $effect(() => {
        const uuid = pack_uuid
        const folder = pack_folder_name
        if (!uuid || !folder || coverByUuid[uuid]) return
        void (async () => {
            if (mode === "library") {
                const local = await localPackCoverAssetUrl(folder)
                if (local) {
                    coverByUuid = { ...coverByUuid, [uuid]: local }
                }
            }
        })()
    })
</script>

<Popover.Root bind:open>
    <Popover.Trigger bind:ref={triggerRef}>
        {#snippet child({ props })}
            <Button
                variant="outline"
                class={cn(
                    "w-[11rem] justify-between gap-2 hover:bg-transparent px-2",
                    open && "border-ring"
                )}
                {...props}
                role="combobox"
                aria-expanded={open}
            >
                <span class="flex min-w-0 items-center gap-2">
                    {#if triggerCover}
                        <img
                            src={triggerCover}
                            alt=""
                            class="size-7 shrink-0 rounded object-cover"
                        />
                    {/if}
                    <span
                        class="truncate text-left text-sm leading-tight"
                        title={pack_label ?? "Any pack"}
                    >
                        {pack_label ?? "Any pack"}
                    </span>
                </span>
                <ChevronDown class="size-4 shrink-0 text-muted-foreground" />
            </Button>
        {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-[min(22rem,90vw)] p-0" align="start">
        <Command.Root shouldFilter={false}>
            <Command.Input
                placeholder="Find pack..."
                bind:value={search}
            />
            <Command.List>
                {#if loading}
                    <div class="py-6 text-center text-sm text-muted-foreground">
                        Loading…
                    </div>
                {:else}
                    <Command.Empty>No packs found</Command.Empty>
                    <Command.Group>
                        <Command.Item
                            onSelect={() => selectPack(null)}
                            class="gap-2"
                        >
                            <Check
                                class={cn(pack_uuid !== null && "text-transparent")}
                            />
                            <span>Any pack</span>
                        </Command.Item>
                        {#each options as opt (opt.uuid)}
                            <Command.Item
                                value={opt.uuid}
                                onSelect={() => selectPack(opt)}
                                class="gap-2"
                            >
                                <Check
                                    class={cn(
                                        pack_uuid !== opt.uuid &&
                                            "text-transparent"
                                    )}
                                />
                                {#if coverByUuid[opt.uuid]}
                                    <img
                                        src={coverByUuid[opt.uuid]}
                                        alt=""
                                        class="size-9 shrink-0 rounded object-cover"
                                    />
                                {:else}
                                    <div
                                        class="size-9 shrink-0 rounded bg-muted"
                                    ></div>
                                {/if}
                                <span
                                    class="line-clamp-2 min-w-0 flex-1 text-left text-sm leading-snug"
                                >
                                    {opt.displayName}
                                </span>
                            </Command.Item>
                        {/each}
                    </Command.Group>
                {/if}
            </Command.List>
        </Command.Root>
    </Popover.Content>
</Popover.Root>
