import type { SampleAsset } from "$lib/splice/types"

const AUDIO_EXT = /\.(wav|mp3|aiff|aif|flac|m4a)$/i

/** On-disk filename: same base name as Splice but always `.mp3`. */
export function sampleStorageFileName(spliceName: string) {
    const base = spliceName.replace(AUDIO_EXT, "")
    return `${base}.mp3`
}

export function sanitizePathSegment(path: string) {
    return path.replace(/[^a-zA-Z0-9#_\-\.\/]/g, "_")
}

/** First directory under samples_dir — always the Splice pack title from GraphQL. */
export function packDirectoryName(sample: SampleAsset) {
    return sanitizePathSegment(sample.parents.items[0].name)
}

/** UI label: leaf name without audio extension. */
export function sampleDisplayFileName(spliceSampleName: string) {
    const leaf = spliceSampleName.split("/").pop() ?? spliceSampleName
    return leaf.replace(AUDIO_EXT, "")
}

function normalizePathToken(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function segmentOverlapsPack(segment: string, packName: string) {
    const a = normalizePathToken(segment)
    const b = normalizePathToken(packName)
    if (!a || !b) return false
    if (a === b) return true
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (short.length < 4) return false
    return long.includes(short)
}

/** Folders that usually start the *musical* tree inside a pack zip. */
const CONTENT_ROOT =
    /^(one_?shots?|onshots|loops?|loopp?|midi|fx|sfx|samples?|audio|drums?|perc|oneshots|drum_?hits?)$/i

function isContentRootFolder(segment: string) {
    const token = normalizePathToken(segment)
    return CONTENT_ROOT.test(segment) || CONTENT_ROOT.test(token)
}

function spliceSampleDirname(spliceSampleName: string) {
    const idx = spliceSampleName.lastIndexOf("/")
    if (idx === -1) return ""
    return spliceSampleName.slice(0, idx)
}

function spliceSampleLeafName(spliceSampleName: string) {
    const idx = spliceSampleName.lastIndexOf("/")
    return idx === -1 ? spliceSampleName : spliceSampleName.slice(idx + 1)
}

/**
 * Drop `VendorPackFolder/One_Shots/...` → `One_Shots/...` when the second segment
 * is a known content root (common Splice zip layout).
 */
function stripLeadingVendorFolder(dirPath: string) {
    const parts = dirPath.split("/").filter(Boolean)
    if (parts.length < 2) return dirPath
    if (isContentRootFolder(parts[1])) {
        return parts.slice(1).join("/")
    }
    return dirPath
}

function compactPathSegment(segment: string, packName: string) {
    if (!segmentOverlapsPack(segment, packName)) return segment

    const dashParts = segment.split(/_-_/).filter(Boolean)
    if (dashParts.length >= 2) {
        const tail = dashParts[dashParts.length - 1]
        if (tail && !segmentOverlapsPack(tail, packName)) {
            return tail
        }
    }
    return segment
}

/** Remove leading folders that repeat the pack title (zip root / display path noise). */
function stripLeadingPackDuplicates(dirPath: string, packName: string) {
    const parts = dirPath.split("/").filter(Boolean)
    while (parts.length > 0 && segmentOverlapsPack(parts[0], packName)) {
        parts.shift()
    }
    return parts.join("/")
}

function compactPackFolderPath(dirPath: string, packName: string) {
    if (!dirPath) return ""
    return dirPath
        .split("/")
        .filter(Boolean)
        .map((part) => compactPathSegment(part, packName))
        .join("/")
}

function processInnerDir(dirPath: string, packName: string) {
    let dir = dirPath
    dir = stripLeadingVendorFolder(dir)
    dir = stripLeadingPackDuplicates(dir, packName)
    dir = compactPackFolderPath(dir, packName)
    return dir
}

function joinPackRelativePath(
    packDir: string,
    dirPath: string,
    leafName: string
) {
    const fileName = sampleStorageFileName(leafName)
    if (dirPath) {
        return sanitizePathSegment(`${packDir}/${dirPath}/${fileName}`)
    }
    return sanitizePathSegment(`${packDir}/${fileName}`)
}

/** Prefer Splice `display_file_path` / `display_name`, then audio `files[].path`, then `name`. */
export function resolveSpliceInnerPath(sample: SampleAsset): {
    dir: string
    leaf: string
} {
    const displayDir = sample.display_file_path?.replace(/^\/+|\/+$/g, "")
    if (displayDir) {
        return {
            dir: displayDir,
            leaf:
                sample.display_name?.trim() ||
                spliceSampleLeafName(sample.name),
        }
    }

    const filePath = sample.files?.[0]?.path?.replace(/^\/+/, "")
    if (filePath?.includes("/")) {
        return {
            dir: spliceSampleDirname(filePath),
            leaf: spliceSampleLeafName(filePath),
        }
    }

    return {
        dir: spliceSampleDirname(sample.name),
        leaf: spliceSampleLeafName(sample.name),
    }
}

export function sampleRelativePathFromAsset(sample: SampleAsset) {
    const packName = sample.parents.items[0].name
    const packDir = packDirectoryName(sample)
    const { dir, leaf } = resolveSpliceInnerPath(sample)
    const trimmedDir = processInnerDir(dir, packName)
    return joinPackRelativePath(packDir, trimmedDir, leaf)
}
