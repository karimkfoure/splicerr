<script lang="ts">
    import "../app.css"
    import { ModeWatcher } from "mode-watcher"
    import { getCurrentWebview } from "@tauri-apps/api/webview"
    import {
        config,
        isSamplesDirValid,
        loadConfig,
        settingsDialog,
    } from "$lib/shared/config.svelte"
    import { onMount } from "svelte"
    import Toaster from "$lib/components/toaster.svelte"
    import { fetchAssets, resetAssetList } from "$lib/shared/store.svelte"
    import { toast } from "$lib/shared/toast.svelte"

    let { children } = $props()

    const DEFAULT_SCALE = 0.8

    $effect(() => {
        getCurrentWebview().setZoom(config.ui_scale * DEFAULT_SCALE)
    })

    onMount(() => {
        void loadConfig()
            .then(() => {
                if (!isSamplesDirValid()) {
                    settingsDialog.open = true
                    return
                }
                resetAssetList()
                fetchAssets()
            })
            .catch((error) => {
                console.error("Failed to initialize the library", error)
                settingsDialog.open = true
                toast("Couldn't open the library. Check the Samples Directory.", {
                    variant: "error",
                    persist: true,
                })
            })
    })
</script>

<ModeWatcher />
<Toaster />
{@render children?.()}
