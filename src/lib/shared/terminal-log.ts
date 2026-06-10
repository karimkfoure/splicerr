import { invoke } from "@tauri-apps/api/core"
import { toast } from "$lib/shared/toast.svelte"

export type TerminalLogLevel = "info" | "warn" | "error"

/** Print to the terminal running `pnpm tauri dev` (and append app cache log). */
export async function terminalLog(
    message: string,
    level: TerminalLogLevel = "warn"
) {
    try {
        await invoke("dev_log", { level, message })
    } catch (error) {
        const detail =
            error instanceof Error ? error.message : String(error)
        toast(
            `dev_log failed (${detail}). Check app cache bulk-download-debug.log if the app was rebuilt.\n\n${message}`,
            {
                variant: "error",
                preformatted: true,
                persist: true,
            }
        )
    }
}
