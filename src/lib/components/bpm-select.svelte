<script lang="ts">
    import { Card } from "$lib/components/ui/card"
    import { cn } from "$lib/utils"
    import ChevronDown from "lucide-svelte/icons/chevron-down"
    import { Slider } from "$lib/components/ui/slider/index.js"
    import { Button } from "$lib/components/ui/button/index.js"
    import { tick } from "svelte"

    const MIN_BPM = 40
    const MAX_BPM = 200

    let {
        class: className,
        bpm = $bindable(),
        min_bpm = $bindable(),
        max_bpm = $bindable(),
        onsubmit,
    }: {
        class?: string
        bpm: string | null
        min_bpm: number | null
        max_bpm: number | null
        onsubmit: () => void
    } = $props()

    let inputRef = $state<HTMLInputElement>(null!)
    let cardRef = $state<HTMLElement>(null!)

    let inputText = $state("")
    let inputRange = $state([100, 120])
    let isKeyboardInput = false

    function clearBpmFilter() {
        bpm = null
        min_bpm = null
        max_bpm = null
        inputText = ""
        inputRange = [100, 120]
        open = false
        onsubmit()
    }

    let open = $state(false)

    let timer: NodeJS.Timeout
    const debounce = (action: () => void, time: number = 200) => {
        clearTimeout(timer)
        timer = setTimeout(() => {
            action()
        }, time)
    }

    const handleBlur = (event: FocusEvent) => {
        const next = event.relatedTarget as Node | null
        if (next && cardRef?.contains(next)) {
            return
        }
        open = false
    }

    const handleInput = () => {
        isKeyboardInput = true
        tick().then(() => {
            isKeyboardInput = false
        })
        const cleaned = inputText.replace(/[^\d\s-]/g, "").trimStart()
        const unchanged = cleaned === inputText
        inputText = cleaned
        if (cleaned.trim() === "") {
            bpm = null
            min_bpm = null
            max_bpm = null
            inputRange = [100, 120]
            debounce(onsubmit)
            return
        }
        if (unchanged) {
            const matches =
                Array.from(
                    cleaned.matchAll(/^\s*(\d+)\s*(-\s*(\d+))?\s*$/g)
                )?.[0]?.filter((match) => match != undefined) ?? []
            if (matches.length == 1 || matches.length == 2) {
                bpm = matches[1]
                min_bpm = null
                max_bpm = null
                const int_bpm = parseInt(bpm)
                inputRange = [int_bpm, int_bpm]
            } else if (matches.length == 4) {
                bpm = null
                min_bpm = parseInt(matches[1])
                max_bpm = parseInt(matches[3])
                if (min_bpm > max_bpm) {
                    const old_max = max_bpm
                    max_bpm = min_bpm
                    min_bpm = old_max
                }
                inputRange = [min_bpm, max_bpm]
            }
            debounce(onsubmit)
        }
    }
</script>

<div>
    <button
        class={cn(
            "flex items-center border-input border px-3 rounded-md w-[180px] cursor-text gap-2 ring-offset-background focus-within:ring-ring focus:ring-ring h-9 justify-between whitespace-nowrap bg-transparent py-2 text-sm shadow-sm focus-within:outline-none focus:outline-none focus-within:ring-1 focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50",
            className
        )}
        onmousedown={(e) => {
            e.preventDefault()
            inputRef.focus()
        }}
        tabindex={-1}
        onclick={() => inputRef.focus()}
        data-command-input-wrapper=""
    >
        <input
            bind:value={inputText}
            bind:this={inputRef}
            type="text"
            maxlength="9"
            placeholder={"Type BPM..."}
            onfocus={() => (open = true)}
            onblur={handleBlur}
            oninput={handleInput}
            onkeydown={(event) => {
                if (event.key === "Escape" || event.key === "Enter") {
                    open = false
                    return
                }
                if (event.key === "ArrowDown") {
                    if (bpm) {
                        bpm = Math.max(parseInt(bpm) - 1, 0).toString()
                        debounce(onsubmit)
                    }
                } else if (event.key === "ArrowUp") {
                    if (bpm) {
                        bpm = Math.max(parseInt(bpm) + 1, 0).toString()
                        debounce(onsubmit)
                    }
                }
                if (event.key == "ArrowDown" || event.key == "ArrowUp") {
                    event.preventDefault()
                }
            }}
            class="select-all w-full h-10 text-sm placeholder:text-transparent focus:placeholder:text-muted-foreground flex rounded-md bg-transparent py-3 outline-none disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <div
            class={cn("absolute text-sm pointer-events-none", open && "hidden")}
        >
            <span class="text-transparent">{inputText}</span>{inputText
                ? ""
                : "Any"} BPM
        </div>
        <ChevronDown class="size-4 shrink-0 text-muted-foreground" />
    </button>
    <div class="relative w-full">
        <div class="absolute top-2 z-10 w-full">
            <!-- TODO: Use a popover instead -->
            <Card
                bind:ref={cardRef}
                class={cn("flex-col rounded-md p-1", open ? "flex" : "hidden")}
                onmousedown={(e) => e.preventDefault()}
            >
                <Button
                    variant="ghost"
                    size="sm"
                    class="w-full justify-start font-normal h-8"
                    onmousedown={(e) => {
                        e.preventDefault()
                        clearBpmFilter()
                    }}
                >
                    Any BPM
                </Button>
                <div
                    class="px-2 py-1.5 text-xs text-muted-foreground font-normal"
                >
                    BPM range
                </div>
                <div class="p-3">
                    <Slider
                        type="multiple"
                        bind:value={inputRange}
                        onValueChange={() => {
                            if (!isKeyboardInput) {
                                if (inputRange[0] != inputRange[1]) {
                                    bpm = null
                                    min_bpm = inputRange[0]
                                    max_bpm = inputRange[1]
                                    inputText = inputRange.join(" - ")
                                } else {
                                    bpm = inputRange[0].toString()
                                    min_bpm = null
                                    max_bpm = null
                                    inputText = bpm
                                }
                                debounce(onsubmit)
                            }
                        }}
                        min={MIN_BPM}
                        max={MAX_BPM}
                        step={1}
                    />
                </div>
            </Card>
        </div>
    </div>
</div>
