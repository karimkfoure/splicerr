# <img src="./src-tauri/icons/128x128.png" width="64"/> Splicerr

> [!IMPORTANT]
> **I am _not_ the developer or maintainer of Splicerr.** This is a temporary
> community fork of [Robert-K/splicerr](https://github.com/Robert-K/splicerr),
> published only to help users while the upstream app is broken.
>
> Splice's GraphQL API started requiring Apollo preflight headers, which stopped
> upstream from loading samples. This fork applies that fix (see upstream
> [issue #30](https://github.com/Robert-K/splicerr/issues/30)) so the app works again.
> **Once the fix is merged upstream, please go back to the [original repository](https://github.com/Robert-K/splicerr).**
>
> All credit goes to the original authors — [@Robert-K](https://github.com/Robert-K)
> and [@ascpixi](https://github.com/ascpixi). As a small bonus, this fork also adds a
> tempo-preserving **Transpose** feature (see [Features](#features)).

**Splicerr** is an alternative frontend for the popular [Splice](https://splice.com/features/sounds) sample library. It does not require any authentication and contains all of the most important features of the regular desktop app (including drag-and-drop).

It's basically a full rewrite of [ascpixi's](https://github.com/ascpixi) [Splicedd ❤️](https://github.com/ascpixi/splicedd), just with a couple more features and built with [Svelte](https://svelte.dev/) and [Tauri 2.0](https://v2.tauri.app/).

Please show your appreciation by starring ⭐ the [original project](https://github.com/ascpixi/splicedd), as it made this all possible.

<p align="center">
  <br>
  <a href="https://github.com/robert-k/splicerr/releases/"><b>Click here to download the latest release!</b></a>
</p>

## Demo

https://github.com/user-attachments/assets/34f1ba90-c881-4a04-a5df-c147bdb51c2c

## Features

- Drag-and-drop samples
- **Local library mirror** (preview saves MP3 + metadata; offline browse via **My library**) ✨ _new in this fork_
- **Resumable local mirror backfill** by sample pack, with pause/resume and retry for failed packs ✨ _new in this fork_
- **Favorites** stored locally with filter in library mode ✨ _new in this fork_
- **Transpose by key or pitch (tempo-preserving)** ✨ _new in this fork_
- Search suggestions
- Tag filtering
- Infinite scrolling
- Waveform previews
- Sort by popularity, bpm & more
- Dark & light mode
- Custom UI scale
- Adjustable preview volume

## 🔧 How to develop

1. Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) & [pnpm](https://pnpm.io/installation)
2. Clone the project: `git clone https://github.com/robert-k/splicerr`
3. Install dependencies: `pnpm i`
4. Start the development server: `pnpm tauri dev`

Set **samples directory** in app settings to enable the local mirror (MP3 + SQLite under `.splicerr/`). For fork-specific architecture and how we iterate, see [AGENTS.md](./AGENTS.md).

For large one-time mirrors, prefer the headless backfill runner:

```bash
pnpm backfill:headless -- --samples-dir /Volumes/disco/splicerr --batch-size 4000 --concurrency 100
```

By default ten random cursor streams list samples in parallel, deduplicate against the local UUID cache, and feed missing samples into one shared download pool. The runner also prepares the next batch while SQLite persists the current one. Use `--mode packs` only when deliberately resuming the pack queue.

### Headless backfill performance log

Representative local runs, normalized to 1,000 saved samples. Network conditions and the cached/missing ratio vary, so treat these as historical throughput markers rather than a formal benchmark.

| Version | Change | Seconds / 1k | Samples / hour | Incremental | vs. baseline |
|---|---|---:|---:|---:|---:|
| [e256832](https://github.com/karimkfoure/splicerr/commit/e256832) | Standard SQLite baseline; per-sample FTS cleanup | 292.0 | 12.3k | — | 1.0x |
| [c044eb9](https://github.com/karimkfoure/splicerr/commit/c044eb9) | Batch FTS cleanup | 45.6 | 78.9k | 6.4x | 6.4x |
| [db95f1f](https://github.com/karimkfoure/splicerr/commit/db95f1f) | Batch paths + DB/listing pipeline | 32.3 | 111.5k | 1.4x | 9.0x |
| [9149522](https://github.com/karimkfoure/splicerr/commit/9149522) | Stream downloads during listing | 27.1 | 132.8k | 1.2x | 10.8x |
| [f07047a](https://github.com/karimkfoure/splicerr/commit/f07047a) | Cache mirrored UUIDs in memory | 26.3 | 136.7k | 1.03x | 11.1x |
| [9e8e2f3](https://github.com/karimkfoure/splicerr/commit/9e8e2f3) | Two parallel GraphQL cursor streams | **18.5** | **194.4k** | 1.42x | **15.8x** |
| [27aa838](https://github.com/karimkfoure/splicerr/commit/27aa838) | Ten streams + 4k batch + concurrency 100 | 6.32 | 569.5k | 2.93x | 46.2x |
| [74b0010](https://github.com/karimkfoure/splicerr/commit/74b0010) | Prefer IPv4 for CDN downloads | **5.75** | **626.1k** | **1.10x** | **50.8x** |

The bounded retry in [b44722a](https://github.com/karimkfoure/splicerr/commit/b44722a) reduced average download-tail latency from 2.34s to 1.78s in its comparison run. Later retry instrumentation recovered all 28 retried downloads in the 2k/100 matrix run.

Experiments that did not win:

| Experiment | Seconds / 1k | Result |
|---|---:|---|
| Concurrency 25 | 39.2 | Downloads underutilized |
| Concurrency 100 | 40.4 | More network/disk contention |
| GraphQL page size 200/500 | No change | Splice caps cursor pages at 100 |
| 4 streams, batch 3k, concurrency 75 | 8.30 | Good intermediate scaling point |
| 10 streams, batch 3k, concurrency 100 | 6.50 | Listing and downloads scale together |
| 10 streams, batch 4k, concurrency 100 | **6.32** | Best operational balance |
| 10 streams, batch 5k, concurrency 100 | 6.31 | Flat gain; more DB/tail pressure |
| 10 streams, batch 3k, concurrency 150 | 6.75 | Higher p95 and more timeouts |
| 20 streams, batch 3k, concurrency 75 | 7.82 | Listing improves; download/DB contention wins |
| Explicit keep-alive, pipeline 1 | 6.72 | Node's default fetch pool was faster |
| Explicit keep-alive, pipeline 4 | 14.66 | HTTP/1.1 head-of-line blocking |
| Network-only concurrency slots | 6.64 | More queued work without more throughput |

## 💡 Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

[![forthebadge](https://forthebadge.com/images/badges/contains-17-coffee-cups.svg)](https://forthebadge.com) [![forthebadge](https://forthebadge.com/images/badges/made-with-out-pants.svg)](https://forthebadge.com) [![forthebadge](https://forthebadge.com/images/badges/works-on-my-machine.svg)](https://forthebadge.com)
