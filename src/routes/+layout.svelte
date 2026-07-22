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
                }
            })
            .catch((error) => {
                console.error("Failed to initialize the library", error)
                settingsDialog.open = true
                const detail =
                    error instanceof Error ? error.message : String(error)
                toast(`Couldn't open the library database: ${detail}`, {
                    variant: "error",
                    persist: true,
                })
            })
    })
</script>

<ModeWatcher />
<Toaster />
{@render children?.()}
