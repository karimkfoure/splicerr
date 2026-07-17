<script lang="ts">
    import * as HoverCard from "$lib/components/ui/hover-card/index.js"
    import type { PackAsset } from "$lib/splice/types"
    import { openUrl } from "@tauri-apps/plugin-opener"
    import { inLibraryState } from "$lib/library/session-cache.svelte"
    import {
        localPackCoverAssetUrl,
    } from "$lib/shared/pack-cover"

    const {
        pack,
        side = "right",
        size = 12,
        class: className,
    }: {
        pack: PackAsset | undefined
        side?: "right" | "top" | "bottom" | "left"
        size?: number
        class?: string
    } = $props()

    const name = $derived(pack?.name.split("/").slice(-1)[0])
    let displaySrc = $state("")
    let imgFailed = $state(false)

    $effect(() => {
        void inLibraryState.version
        const packName = pack?.name
        const embedded = pack?.files?.find(
            (file) => file.asset_file_type_slug === "cover_image"
        )?.url
        imgFailed = false
        if (!packName) {
            displaySrc = ""
            return
        }
        if (embedded) {
            displaySrc = embedded
            return
        }
        void (async () => {
            const local = await localPackCoverAssetUrl(packName)
            if (local) {
                displaySrc = local
                return
            }
            displaySrc = ""
        })()
    })

    function handleImageError() {
        imgFailed = true
    }

    const packURL = $derived(
        `https://splice.com/sounds/packs/${pack?.permalink_base_url}/${pack?.permalink_slug}`
    )
</script>

{#if pack}
    <HoverCard.Root>
        <HoverCard.Trigger
            class="flex-shrink-0"
            onclick={() => pack && pack.permalink_slug && openUrl(packURL)}
        >
            {#if displaySrc && !imgFailed}
                <img
                    src={displaySrc}
                    alt={name}
                    class={`size-${size} rounded`}
                    draggable="false"
                    onerror={handleImageError}
                />
            {:else}
                <div
                    class={`size-${size} rounded bg-muted flex items-center justify-center text-[10px] text-muted-foreground px-0.5 text-center leading-tight`}
                    title={name}
                >
                    Pack
                </div>
            {/if}
        </HoverCard.Trigger>
        <HoverCard.Content {side} class="flex flex-col justify-center gap-2">
            {#if displaySrc && !imgFailed}
                <button
                    type="button"
                    onclick={() => pack && pack.permalink_slug && openUrl(packURL)}
                >
                    <img
                        src={displaySrc}
                        alt={name}
                        class="w-full rounded"
                        onerror={handleImageError}
                    />
                </button>
            {/if}
            <p>{name}</p>
        </HoverCard.Content>
    </HoverCard.Root>
{:else}
    <div class={`size-${size} rounded flex-shrink-0 bg-muted`}></div>
{/if}
