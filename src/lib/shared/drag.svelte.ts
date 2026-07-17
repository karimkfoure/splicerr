import { startDrag } from "@crabnebula/tauri-plugin-drag"
import { join, appCacheDir } from "@tauri-apps/api/path"
import { exists, create, mkdir, readFile } from "@tauri-apps/plugin-fs"
import { savePackImage } from "./files.svelte"
import { regenerateExportedSampleWav } from "$lib/library/export"
import { setCachedInLibrary } from "$lib/library/session-cache.svelte"
import { loading } from "./loading.svelte"
import { isSamplesDirValid, settingsDialog } from "$lib/shared/config.svelte"
import type { SampleAsset, PackAsset } from "$lib/splice/types"

async function createDragIcon(
    packImagePath: string,
    packId: string
): Promise<string> {
    const cacheDir = await appCacheDir()
    const iconPath = await join(cacheDir, `${packId}.png`)

    if (!(await exists(iconPath))) {
        // Ensure cache directory exists
        if (!(await exists(cacheDir))) {
            await mkdir(cacheDir)
        }

        // Read the saved pack image file
        const imageData = await readFile(packImagePath)
        const buffer = new ArrayBuffer(imageData.byteLength)
        const view = new Uint8Array(buffer)
        view.set(imageData)
        const resizedImageData = await resizeImageToCorner(buffer)
        const file = await create(iconPath)
        await file.write(resizedImageData)
        await file.close()
    }

    return iconPath
}

async function createInvisibleIcon(): Promise<string> {
    const cacheDir = await appCacheDir()
    const iconPath = await join(cacheDir, "invisible-drag-icon.png")

    if (!(await exists(iconPath))) {
        if (!(await exists(cacheDir))) {
            await mkdir(cacheDir)
        }

        const transparentPng = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
            0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
            0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x02, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
            0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ])

        const file = await create(iconPath)
        await file.write(transparentPng)
        await file.close()
    }

    return iconPath
}

async function resizeImageToCorner(
    imageBuffer: ArrayBuffer
): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const blob = new Blob([imageBuffer])
        const img = new Image()
        const iconSize = 64
        img.onload = () => {
            const canvasWidth = iconSize * 2
            const canvasHeight = iconSize * 2.5
            const canvas = document.createElement("canvas")
            const ctx = canvas.getContext("2d")!

            canvas.width = canvasWidth
            canvas.height = canvasHeight

            // Transparent background
            ctx.clearRect(0, 0, canvasWidth, canvasHeight)

            // Position the image in the top-right corner of the canvas
            const x = canvasWidth - iconSize
            const y = 0

            ctx.drawImage(img, x, y, iconSize, iconSize)

            canvas.toBlob((blob) => {
                blob!.arrayBuffer().then((buffer) => {
                    resolve(new Uint8Array(buffer))
                })
            }, "image/png")
        }
        img.src = URL.createObjectURL(blob)
    })
}

export async function handleSampleDownload(sampleAsset: SampleAsset) {
    if (!isSamplesDirValid()) {
        settingsDialog.open = true
        return
    }

    console.log("⬇️ Downloading", sampleAsset.name)

    try {
        loading.setCursor(true)
        const result = await regenerateExportedSampleWav(sampleAsset)
        setCachedInLibrary(sampleAsset.uuid, true)
        console.log("💾 Exported WAV at", result.absolutePath)
    } catch (e) {
        console.error("⚠️ Error downloading", e)
        throw e
    } finally {
        loading.setCursor(false)
    }
}

export async function handleSampleDrag(event: DragEvent, sampleAsset: SampleAsset) {
    event.preventDefault()
    console.log("🫳 Dragging", sampleAsset.name)

    try {
        loading.setCursor(true)
        const exportResult = await regenerateExportedSampleWav(sampleAsset)
        const path = exportResult.absolutePath
        setCachedInLibrary(sampleAsset.uuid, true)

        console.info("WAV drag export", {
            uuid: sampleAsset.uuid,
            name: sampleAsset.name,
            correctionEnabled: exportResult.correctionEnabled,
            declaredPaddingSamples: exportResult.declaredPaddingSamples,
            calculatedPaddingSamples: exportResult.calculatedPaddingSamples,
            sampleRate: exportResult.sampleRate,
            sourceFrames: exportResult.sourceFrames,
            outputFrames: exportResult.outputFrames,
            startTrimSamples: exportResult.startTrimSamples,
            endTrimSamples: exportResult.endTrimSamples,
            endPaddingSamples: exportResult.endPaddingSamples,
            targetBeats: exportResult.targetBeats,
            gridConfident: exportResult.gridConfident,
            path,
        })

        // Save pack image to samples directory and use it as drag icon
        const pack = sampleAsset.parents.items[0] as PackAsset
        let iconPath: string

        const packImagePath = await savePackImage(sampleAsset)

        // Check if the image exists and use it, otherwise fallback to invisible icon
        if (packImagePath && await exists(packImagePath)) {
            iconPath = await createDragIcon(packImagePath, pack.uuid)
        } else {
            iconPath = await createInvisibleIcon()
        }

        startDrag({ item: [path], icon: iconPath })
    } catch (e) {
        console.error("⚠️ Error dragging", e)
    } finally {
        loading.setCursor(false)
    }
}
