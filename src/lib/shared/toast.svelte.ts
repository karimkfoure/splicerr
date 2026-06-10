export type ToastVariant = "default" | "info" | "success" | "warning" | "error"

export type ToastEntry = {
    id: number
    message: string
    variant: ToastVariant
    /** Multiline debug dumps (wider, monospace). */
    preformatted?: boolean
}

let nextId = 0

export const toastState = $state({
    items: [] as ToastEntry[],
})

export function toast(
    message: string,
    options?: {
        variant?: ToastVariant
        durationMs?: number
        preformatted?: boolean
        /** Stay until the user dismisses (for debug dumps). */
        persist?: boolean
    }
) {
    const id = ++nextId
    const variant = options?.variant ?? "default"
    const durationMs = options?.durationMs ?? 10_000
    toastState.items.push({
        id,
        message,
        variant,
        preformatted: options?.preformatted,
    })
    if (!options?.persist) {
        window.setTimeout(() => dismissToast(id), durationMs)
    }
}

export function dismissToast(id: number) {
    const index = toastState.items.findIndex((t) => t.id === id)
    if (index >= 0) toastState.items.splice(index, 1)
}
