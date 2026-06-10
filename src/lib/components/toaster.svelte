<script lang="ts">
    import { cn } from "$lib/utils"
    import CircleX from "lucide-svelte/icons/circle-x"
    import {
        dismissToast,
        toastState,
        type ToastVariant,
    } from "$lib/shared/toast.svelte"

    const variantClass: Record<ToastVariant, string> = {
        default: "border-border bg-background text-foreground",
        info: "border-border bg-muted text-foreground",
        success:
            "border-green-600/40 bg-green-950/90 text-green-50 dark:bg-green-950/80",
        warning:
            "border-amber-600/40 bg-amber-950/90 text-amber-50 dark:bg-amber-950/80",
        error: "border-destructive/50 bg-destructive text-destructive-foreground",
    }
</script>

<div
    class="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-lg flex-col gap-2"
    aria-live="polite"
>
    {#each toastState.items as entry (entry.id)}
        <div
            class={cn(
                "pointer-events-auto flex max-h-[min(70vh,28rem)] items-start gap-2 overflow-y-auto rounded-lg border px-3 py-2 text-sm shadow-lg",
                entry.preformatted && "max-w-lg",
                variantClass[entry.variant]
            )}
            role="status"
        >
            <p
                class={cn(
                    "min-w-0 flex-1 leading-snug",
                    entry.preformatted &&
                        "whitespace-pre-wrap font-mono text-[11px] leading-relaxed"
                )}
            >
                {entry.message}
            </p>
            <button
                type="button"
                class="shrink-0 rounded opacity-70 hover:opacity-100"
                aria-label="Dismiss"
                onclick={() => dismissToast(entry.id)}
            >
                <CircleX class="size-4" />
            </button>
        </div>
    {/each}
</div>
