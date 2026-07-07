<script lang="ts">
    import * as Dialog from "$lib/components/ui/dialog"
    import Button from "$lib/components/ui/button/button.svelte"
    import LoaderCircle from "lucide-svelte/icons/loader-circle"
    import RotateCcw from "lucide-svelte/icons/rotate-ccw"
    import Pause from "lucide-svelte/icons/pause"
    import Play from "lucide-svelte/icons/play"
    import {
        mirrorBackfillState,
        refreshMirrorBackfillSummary,
        requestStopMirrorBackfill,
        retryMirrorBackfillFailures,
        startMirrorBackfill,
    } from "$lib/shared/mirror-backfill.svelte"

    let { open = $bindable(false) }: { open: boolean } = $props()

    $effect(() => {
        if (open) void refreshMirrorBackfillSummary()
    })

    const summary = $derived(mirrorBackfillState.summary)
    const totalPacks = $derived(summary?.totalPacks ?? 0)
    const completedPacks = $derived(summary?.completedPacks ?? 0)
    const failedPacks = $derived(summary?.failedPacks ?? 0)
    const queuedPacks = $derived(summary?.queuedPacks ?? 0)
    const cachedSamples = $derived(summary?.cachedSamples ?? 0)
    const totalSamples = $derived(summary?.totalSamples ?? 0)

    function pct(done: number, total: number) {
        if (total <= 0) return 0
        return Math.min(100, Math.round((done / total) * 100))
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="max-w-xl">
        <Dialog.Header>
            <Dialog.Title>Local mirror backfill</Dialog.Title>
            <Dialog.Description>
                Persistent pack-by-pack sync for your local Splice library.
            </Dialog.Description>
        </Dialog.Header>

        <div class="flex flex-col gap-4">
            <div class="grid grid-cols-2 gap-2 text-sm">
                <div class="rounded-md border p-3">
                    <div class="text-xs text-muted-foreground">Packs</div>
                    <div class="tabular-nums font-medium">
                        {completedPacks.toLocaleString()} / {totalPacks.toLocaleString()}
                    </div>
                    <div class="text-xs text-muted-foreground">
                        {pct(completedPacks, totalPacks)}% complete
                    </div>
                </div>
                <div class="rounded-md border p-3">
                    <div class="text-xs text-muted-foreground">Samples</div>
                    <div class="tabular-nums font-medium">
                        {cachedSamples.toLocaleString()} / {totalSamples.toLocaleString()}
                    </div>
                    <div class="text-xs text-muted-foreground">
                        {summary?.sessionSaved.toLocaleString() ?? "0"} saved this job
                    </div>
                </div>
                <div class="rounded-md border p-3">
                    <div class="text-xs text-muted-foreground">Queue</div>
                    <div class="tabular-nums font-medium">
                        {queuedPacks.toLocaleString()} pending
                    </div>
                    <div class="text-xs text-muted-foreground">
                        {failedPacks.toLocaleString()} failed
                    </div>
                </div>
                <div class="rounded-md border p-3">
                    <div class="text-xs text-muted-foreground">Status</div>
                    <div class="font-medium capitalize">
                        {mirrorBackfillState.running
                            ? mirrorBackfillState.phase
                            : summary?.status ?? "idle"}
                    </div>
                    <div class="text-xs text-muted-foreground truncate">
                        {summary?.currentPackName ??
                            mirrorBackfillState.currentPackName ??
                            "No active pack"}
                    </div>
                </div>
            </div>

            {#if mirrorBackfillState.phase === "catalog"}
                <div class="text-xs text-muted-foreground tabular-nums">
                    Cataloging packs page {mirrorBackfillState.catalogPage.toLocaleString()}
                    / {mirrorBackfillState.catalogTotalPages.toLocaleString()}
                </div>
            {/if}

            {#if mirrorBackfillState.phase === "pack"}
                <div class="text-xs text-muted-foreground tabular-nums">
                    Current pack:
                    {mirrorBackfillState.currentPackListed.toLocaleString()}
                    / {mirrorBackfillState.currentPackTotal.toLocaleString()}
                    listed · {mirrorBackfillState.currentPackSaved.toLocaleString()}
                    saved
                </div>
            {/if}

            {#if summary?.lastError}
                <div class="rounded-md border border-destructive/40 p-3 text-xs">
                    {summary.lastError}
                </div>
            {/if}
        </div>

        <Dialog.Footer>
            <Button variant="outline" onclick={() => (open = false)}
                >Close</Button
            >
            <Button
                variant="outline"
                disabled={mirrorBackfillState.running || failedPacks === 0}
                onclick={() => void retryMirrorBackfillFailures()}
            >
                <RotateCcw class="size-4" />
                Retry failed
            </Button>
            {#if mirrorBackfillState.running}
                <Button onclick={() => void requestStopMirrorBackfill()}>
                    <Pause class="size-4" />
                    Pause
                </Button>
            {:else}
                <Button onclick={() => void startMirrorBackfill()}>
                    {#if mirrorBackfillState.running}
                        <LoaderCircle class="size-4 animate-spin" />
                    {:else}
                        <Play class="size-4" />
                    {/if}
                    Start / Resume
                </Button>
            {/if}
        </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
