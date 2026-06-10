<script lang="ts">
    import * as Select from "$lib/components/ui/select/index"
    import ChevronDown from "lucide-svelte/icons/chevron-down"
    import { cn } from "$lib/utils"
    import type { AssetSortType, SortOrder } from "$lib/splice/types"
    import type { BrowseMode } from "$lib/library/api"

    let {
        sort = $bindable(),
        onselect,
        order,
        mode = "splice",
    }: {
        sort: string
        onselect: (value: string) => void
        order: SortOrder
        mode?: BrowseMode
    } = $props()

    const spliceOptions = [
        { value: "random", label: "Random" },
        { value: "relevance", label: "Most relevant" },
        { value: "popularity", label: "Most popular" },
        { value: "recency", label: "Most recent" },
    ] as const

    const libraryOptions = [
        { value: "ingested_at", label: "Recently added" },
        { value: "pack_popularity", label: "Pack popularity" },
        { value: "name", label: "Filename" },
        { value: "pack_name", label: "Pack" },
        { value: "duration", label: "Time" },
        { value: "key", label: "Key" },
        { value: "bpm", label: "BPM" },
    ] as const

    const options = $derived(
        mode === "library" ? [...libraryOptions] : [...spliceOptions]
    )

    const orderedSorts = new Set<string>(
        libraryOptions.map((o) => o.value).filter((v) => v !== "random")
    )

    let triggerLabel = $state("")
    let showOrder = $state(false)

    $effect(() => {
        const label = options.find((option) => option.value === sort)?.label
        triggerLabel = label ?? "Sort by..."
        showOrder =
            mode === "library" &&
            orderedSorts.has(sort)
    })
</script>

<Select.Root
    type="single"
    bind:value={sort}
    onValueChange={(value) => {
        if (value) onselect(value)
    }}
>
    <Select.Trigger class="w-[180px]">
        <div class="flex items-center">
            {triggerLabel}
            {#if showOrder}
                <ChevronDown
                    size="18"
                    class={cn(
                        "transition-transform ease-in-out",
                        order == "ASC" ? "rotate-[-180deg]" : ""
                    )}
                />
            {/if}
        </div>
    </Select.Trigger>
    <Select.Content>
        <Select.Group>
            <Select.GroupHeading class="text-xs text-muted-foreground font-normal"
                >Sort by</Select.GroupHeading
            >
            {#each options as option}
                <Select.Item value={option.value} label={option.label}
                    >{option.label}</Select.Item
                >
            {/each}
        </Select.Group>
    </Select.Content>
</Select.Root>
