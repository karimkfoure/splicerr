import { invoke } from "@tauri-apps/api/core"

/** Rust `[splicerr] ui: …` in the `pnpm tauri dev` terminal (debug builds only). */
export async function terminalLog(message: string) {
    try {
        const internals = (
            globalThis as typeof globalThis & {
                __TAURI_INTERNALS__?: { invoke: typeof invoke }
            }
        ).__TAURI_INTERNALS__
        if (internals?.invoke) {
            await internals.invoke("splicerr_debug_log", { message })
        }
    } catch {
        /* IPC not ready */
    }
}
