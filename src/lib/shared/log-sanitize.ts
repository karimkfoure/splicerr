/** Redact presigned S3 URLs and noisy request errors for terminal logs. */
export function sanitizeDownloadLogMessage(message: string): string {
    let out = message
    out = out.replace(
        /https:\/\/[^\s)]*spliceproduction\.s3[^\s)]*/gi,
        "https://[s3-redacted]"
    )
    out = out.replace(
        /error sending request for url \([^)]+\)/gi,
        "error sending request for url ([redacted])"
    )
    if (out.length > 800) {
        out = `${out.slice(0, 800)}…`
    }
    return out
}
