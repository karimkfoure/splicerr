<script lang="ts">
    import { cn } from "$lib/utils"
    import { loadLocalWaveform } from "$lib/library/local-waveform"

    let ref = null! as HTMLButtonElement
    let canvas = null! as HTMLCanvasElement
    let {
        relativeAudioPath,
        enabled,
        progress = 0,
        class: className,
        onseek,
    }: {
        relativeAudioPath: string
        enabled: boolean
        progress?: number
        class?: string
        onseek: (progress: number) => void
    } = $props()

    let bins = $state<[number, number, number][]>([])
    let loadedPath = $state("")

    function draw() {
        if (!canvas || !bins.length) return
        const context = canvas.getContext("2d")
        if (!context) return
        const { width, height } = canvas
        context.clearRect(0, 0, width, height)
        const columnWidth = width / bins.length
        for (let index = 0; index < bins.length; index += 1) {
            const [low, mid, high] = bins[index]
            const peak = Math.max(low, mid, high)
            if (!peak) continue
            const scale = 255 / peak
            const barHeight = Math.max(2, (peak / 255) * height)
            context.fillStyle = `rgb(${Math.round(low * scale)}, ${Math.round(mid * scale)}, ${Math.round(high * scale)})`
            context.fillRect(
                index * columnWidth,
                (height - barHeight) / 2,
                Math.max(1, columnWidth - 1),
                barHeight
            )
        }
    }

    $effect(() => {
        if (!enabled || !relativeAudioPath || loadedPath === relativeAudioPath) return
        const requested = relativeAudioPath
        const controller = new AbortController()
        const timer = window.setTimeout(() => {
            loadLocalWaveform(requested, controller.signal)
                .then((result) => {
                    if (requested !== relativeAudioPath) return
                    bins = result.bins
                    loadedPath = requested
                })
                .catch((error) => {
                    if (error instanceof DOMException && error.name === "AbortError") return
                    console.debug("Local waveform unavailable", error)
                })
        }, 80)
        return () => {
            window.clearTimeout(timer)
            controller.abort()
        }
    })

    $effect(() => {
        bins
        draw()
    })

    $effect(() => {
        if (!canvas) return
        const resize = () => {
            const scale = window.devicePixelRatio || 1
            const width = Math.max(1, Math.round(canvas.clientWidth * scale))
            const height = Math.max(1, Math.round(canvas.clientHeight * scale))
            if (canvas.width === width && canvas.height === height) return
            canvas.width = width
            canvas.height = height
            draw()
        }
        const observer = new ResizeObserver(resize)
        observer.observe(canvas)
        resize()
        return () => observer.disconnect()
    })
</script>

<button
    class={cn(className, "relative flex items-center focus:outline-none cursor-grab")}
    tabindex={-1}
    onclick={(event) => {
        const rect = ref.getBoundingClientRect()
        onseek((event.clientX - rect.left) / rect.width)
    }}
    bind:this={ref}
    aria-label="Waveform"
>
    <canvas bind:this={canvas} width="320" height="96" class="size-full"></canvas>
    <span
        class="pointer-events-none absolute inset-y-0 left-0 bg-white/20 mix-blend-screen"
        style:width={`${Math.max(0, Math.min(1, progress)) * 100}%`}
    ></span>
</button>
