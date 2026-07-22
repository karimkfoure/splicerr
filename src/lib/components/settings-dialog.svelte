<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog"
    import Settings from "lucide-svelte/icons/settings"
    import { buttonVariants } from "$lib/components/ui/button/index.js"
    import { cn } from "$lib/utils"
    import ExternalLink from "$lib/components/external-link.svelte"
    import Input from "$lib/components/ui/input/input.svelte"
    import Button from "$lib/components/ui/button/button.svelte"
    import FolderOpen from "lucide-svelte/icons/folder-open"
    import TriangleAlert from "lucide-svelte/icons/triangle-alert"
    import Undo2 from "lucide-svelte/icons/undo-2"
    import Label from "$lib/components/ui/label/label.svelte"
    import {
        config,
        getLibraryConnectionError,
        isSamplesDirValid,
        saveConfig,
        settingsDialog,
        updateTheme,
    } from "$lib/shared/config.svelte"
    import Slider from "$lib/components/ui/slider/slider.svelte"
    import { open as openDialog } from "@tauri-apps/plugin-dialog"
    import ThemeSelect from "./theme-select.svelte"
    import Switch from "$lib/components/ui/switch/switch.svelte"
    import LoaderCircle from "lucide-svelte/icons/loader-circle"
    import {
        popularitySyncState,
        refreshPopularitySyncStatus,
        startPopularitySuperSync,
    } from "$lib/shared/popularity-sync.svelte"

    let flashbangAudio = $state<HTMLAudioElement>(null!)

    const lastPopularitySync = $derived(
        popularitySyncState.status?.lastCompletedAt
            ? new Date(
                  popularitySyncState.status.lastCompletedAt
              ).toLocaleString()
            : "Never"
    )

    $effect(() => {
        if (settingsDialog.open && isSamplesDirValid()) {
            void refreshPopularitySyncStatus()
        }
    })
</script>

<Dialog.Root bind:open={settingsDialog.open}>
    <Dialog.Trigger
        class={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "text-muted-foreground flex-shrink-0"
        )}><Settings /></Dialog.Trigger
    >
    <Dialog.Content class="max-h-[90vh] overflow-y-auto">
        <Dialog.Header>
            <Dialog.Title>Settings</Dialog.Title>
        </Dialog.Header>
        <div class="flex flex-col gap-4 py-4">
            <div class="flex flex-col gap-2">
                <Label for="fileInput">Samples Directory</Label>
                <p class="text-muted-foreground text-sm">
                    This is where splicerrerr will place the Packs & Samples you
                    download.
                </p>
                <div class="flex gap-2">
                    <Input
                        type="text"
                        class={isSamplesDirValid()
                            ? ""
                            : "border-warn focus-visible:border-warn focus-visible:outline-warn"}
                        placeholder="e.g. .../Documents/Samples/Splice"
                        bind:value={config.samples_dir}
                        oninput={saveConfig}
                    />
                    <Button
                        class="flex-shrink-0 text-accent-foreground"
                        size="icon"
                        variant="outline"
                        onclick={() => {
                            openDialog({
                                multiple: false,
                                directory: true,
                            }).then((path) => {
                                if (path) {
                                    config.samples_dir = path
                                    saveConfig()
                                }
                            })
                        }}><FolderOpen /></Button
                    >
                </div>
                <div
                    class={cn(
                        "flex gap-2 items-center text-warn text-sm",
                        isSamplesDirValid() && "opacity-0"
                    )}
                >
                    <TriangleAlert size="16" />
                    Enter a valid path to an existing directory.
                </div>
                {#if getLibraryConnectionError()}
                    <div class="flex gap-2 items-start text-warn text-sm">
                        <TriangleAlert size="16" class="mt-0.5 shrink-0" />
                        <span>
                            The folder exists, but its library database couldn't
                            be opened: {getLibraryConnectionError()}
                        </span>
                    </div>
                {/if}
            </div>
            <div class="flex flex-col gap-2">
                <Label>Offline Pack Popularity</Label>
                <p class="text-muted-foreground text-sm">
                    Explore Splice's full GraphQL pack ranking and save the
                    popularity order for offline browsing.
                </p>
                <p class="text-sm">
                    Last full sync: <span class="font-medium"
                        >{lastPopularitySync}</span
                    >
                </p>
                {#if popularitySyncState.running}
                    <p class="text-muted-foreground text-sm">
                        Exploring page {popularitySyncState.requestedPage} ·
                        {popularitySyncState.status?.listedCount ?? 0} remote packs
                        scanned ·
                        {popularitySyncState.status?.rankedLocalPacks ?? 0}/{popularitySyncState
                            .status?.totalLocalPacks ?? 0} local packs ranked
                    </p>
                {:else if popularitySyncState.status}
                    <p class="text-muted-foreground text-sm">
                        {popularitySyncState.status.rankedLocalPacks}/{popularitySyncState
                            .status.totalLocalPacks} local packs currently ranked
                    </p>
                {/if}
                {#if popularitySyncState.error}
                    <p class="text-warn text-sm">{popularitySyncState.error}</p>
                {/if}
                <Button
                    class="w-fit text-accent-foreground"
                    variant="outline"
                    disabled={!isSamplesDirValid() || popularitySyncState.running}
                    onclick={startPopularitySuperSync}
                >
                    {#if popularitySyncState.running}
                        <LoaderCircle class="animate-spin" />
                        Syncing popularity…
                    {:else}
                        Super sync popularity
                    {/if}
                </Button>
            </div>
            <div class="flex flex-col gap-2">
                <Label for="themeSelect">Theme</Label>
                <div class="flex gap-2">
                    <ThemeSelect
                        bind:value={config.ui_theme}
                        onselect={() => {
                            if (config.ui_theme == "light")
                                flashbangAudio.play()
                            updateTheme()
                            saveConfig()
                        }}
                    />
                    <audio
                        bind:this={flashbangAudio}
                        src="/flashbang.mp3"
                        preload="auto"
                    ></audio>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <Label for="uiScaleSlider">UI Scale</Label>
                <div class="flex gap-4">
                    <Slider
                        id="uiScaleSlider"
                        min={0.5}
                        max={2}
                        step={0.1}
                        type="single"
                        bind:value={config.ui_scale}
                        onValueCommit={saveConfig}
                    />
                    <Button
                        class="flex-shrink-0 text-accent-foreground"
                        size="icon"
                        variant="outline"
                        onclick={() => {
                            config.ui_scale = 1
                            saveConfig()
                        }}
                    >
                        <Undo2 />
                    </Button>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <Label for="wavCorrectionToggle">WAV Correction</Label>
                <p class="text-muted-foreground text-sm">
                    Trim MP3 padding and correct loop length when exporting WAV
                    files. Enabled by default.
                </p>
                <div class="flex items-center gap-2">
                    <Switch
                        id="wavCorrectionToggle"
                        checked={config.wav_correction_enabled}
                        onchange={() => {
                            config.wav_correction_enabled =
                                !config.wav_correction_enabled
                            saveConfig()
                        }}
                    />
                    <Label for="wavCorrectionToggle" class="cursor-pointer">
                        {config.wav_correction_enabled ? "Enabled" : "Disabled"}
                    </Label>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <Label for="repeatAudioToggle">Repeat Audio</Label>
                <p class="text-muted-foreground text-sm">
                    When enabled, audio will repeat after finishing.
                </p>
                <div class="flex items-center gap-2">
                    <Switch
                        id="repeatAudioToggle"
                        bind:checked={config.repeat_audio}
                        onchange={() => {
                            config.repeat_audio = !config.repeat_audio
                            saveConfig()
                        }}
                    />
                    <Label for="repeatAudioToggle" class="cursor-pointer">
                        {config.repeat_audio ? "Enabled" : "Disabled"}
                    </Label>
                </div>
            </div>
        </div>
        <Dialog.Footer>
            <div
                class="text-muted-foreground inline-flex items-center text-nowrap"
            >
                Made with&nbsp;
                <ExternalLink to="https://svelte.dev" class="shrink-0"
                    ><img
                        class="size-6 align-middle"
                        src="/svelte.svg"
                        alt="Svelte"
                    /></ExternalLink
                >
                &nbsp;+&nbsp;
                <ExternalLink to="https://tauri.app" class="shrink-0"
                    ><img
                        class="size-6 align-middle"
                        src="/tauri.svg"
                        alt="Tauri"
                    /></ExternalLink
                >
                &nbsp;&&nbsp;
                <ExternalLink
                    to="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                    class="text-2xl align-middle">❤️</ExternalLink
                >
                &nbsp;by&nbsp;
                <ExternalLink
                    to="https://github.com/Robert-K"
                    class="text-primary">Kosro,</ExternalLink
                >
                &nbsp;inspired by&nbsp;
                <ExternalLink
                    to="https://github.com/ascpixi"
                    class="text-primary">ascpixi</ExternalLink
                >
            </div>
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
