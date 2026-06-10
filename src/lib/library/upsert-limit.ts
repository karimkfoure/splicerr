/** Cap concurrent `library_upsert_from_asset` invokes to reduce SQLite bridge contention. */
const LIBRARY_UPSERT_MAX = 20

let active = 0
const waitQueue: (() => void)[] = []

function releaseSlot() {
    active--
    const next = waitQueue.shift()
    if (next) next()
}

function acquireSlot(): Promise<void> {
    if (active < LIBRARY_UPSERT_MAX) {
        active++
        return Promise.resolve()
    }
    return new Promise((resolve) => {
        waitQueue.push(() => {
            active++
            resolve()
        })
    })
}

export async function withLibraryUpsertLimit<T>(
    fn: () => Promise<T>
): Promise<T> {
    await acquireSlot()
    try {
        return await fn()
    } finally {
        releaseSlot()
    }
}
