import { appConfigDir, isAbsolute } from "@tauri-apps/api/path"
import {
    exists,
    BaseDirectory,
    readTextFile,
    create,
    writeTextFile,
    mkdir,
    stat,
} from "@tauri-apps/plugin-fs"
import { resetMode, setMode } from "mode-watcher"
import { syncLibraryConnection } from "$lib/library/lifecycle"

const CONFIG_FILE_NAME = "config.json"

export type UITheme = "system" | "light" | "dark"

export type TransposeMode = "key" | "pitch"
export type NoteSpelling = "flat" | "sharp"

export type TransposeConfig = {
    enabled: boolean
    mode: TransposeMode
    target_key: string
    spelling: NoteSpelling
    semitones: number
}

const DEFAULT_TRANSPOSE: TransposeConfig = {
    enabled: false,
    mode: "key",
    target_key: "C",
    spelling: "flat",
    semitones: 0,
}

const DEFAULT_CONFIG = {
    samples_dir: null as string | null,
    ui_theme: "system" as UITheme,
    ui_scale: 1,
    wav_correction_enabled: true,
    repeat_audio: true,
    transpose: { ...DEFAULT_TRANSPOSE } as TransposeConfig,
}

let samplesDirValid = $state(false)

export let settingsDialog = $state({ open: false })
export const configLoadState = $state({ loaded: false })

export const isSamplesDirValid = () => samplesDirValid

export let config = $state<typeof DEFAULT_CONFIG>(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG))
)

export async function validateSamplesDir() {
    async function validate() {
        if (!config.samples_dir) return false
        if (!(await isAbsolute(config.samples_dir))) return false
        if (!(await exists(config.samples_dir))) return false
        if (!(await stat(config.samples_dir)).isDirectory) return false
        return true
    }

    samplesDirValid = await validate()
    await syncLibraryConnection()

    console.log(
        samplesDirValid
            ? "✅ Samples Directory valid"
            : "❌ Samples Directory invalid"
    )

    return samplesDirValid
}

export async function loadConfig() {
    if (
        !(await exists(CONFIG_FILE_NAME, { baseDir: BaseDirectory.AppConfig }))
    ) {
        console.log("📂 Config not found, keeping default")
    } else {
        const fileContent = await readTextFile("config.json", {
            baseDir: BaseDirectory.AppConfig,
        })
        const parsed = JSON.parse(fileContent)
        // Discard the upstream fixed-millisecond toggle. It is not part of the
        // sample-based export policy and must not be written back to config.
        const { cut_mp3_delay: _legacyMp3Delay, ...currentConfig } = parsed
        // Merge nested transpose separately so configs from older versions keep new defaults
        const transpose = {
            ...DEFAULT_TRANSPOSE,
            ...(currentConfig.transpose ?? {}),
        }
        Object.assign(config, currentConfig)
        config.transpose = transpose
        console.log("📂 Config loaded")
    }

    await validateSamplesDir()
    configLoadState.loaded = true
}

export async function saveConfig() {
    await validateSamplesDir()

    const appConfig = await appConfigDir()
    if (!(await exists(appConfig))) await mkdir(appConfig)

    if (
        !(await exists(CONFIG_FILE_NAME, { baseDir: BaseDirectory.AppConfig }))
    ) {
        await create(CONFIG_FILE_NAME, { baseDir: BaseDirectory.AppConfig })
    }

    await writeTextFile(CONFIG_FILE_NAME, JSON.stringify(config), {
        baseDir: BaseDirectory.AppConfig,
    })
    console.log("💾 Config saved")
}

export function updateTheme() {
    switch (config.ui_theme) {
        case "system":
            resetMode()
            break
        default:
            setMode(config.ui_theme)
            break
    }
}
