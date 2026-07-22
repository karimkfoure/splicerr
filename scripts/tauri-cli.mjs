import net from "node:net"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const DEV_PORT = 1337

function canConnect(host) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port: DEV_PORT })
        socket.setTimeout(400)
        socket.once("connect", () => {
            socket.destroy()
            resolve(true)
        })
        socket.once("timeout", () => {
            socket.destroy()
            resolve(false)
        })
        socket.once("error", () => resolve(false))
    })
}

async function devServerIsRunning() {
    return (await canConnect("::1")) || (await canConnect("127.0.0.1"))
}

if (args[0] === "dev" && (await devServerIsRunning())) {
    console.error(
        `Cannot start splicerrerr: port ${DEV_PORT} is already in use.\n` +
            "Close the previous tauri dev process before starting a new one."
    )
    process.exit(1)
}

const child = spawn("tauri", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
})

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal))
}

child.once("error", (error) => {
    console.error(`Failed to start Tauri: ${error.message}`)
    process.exitCode = 1
})

child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
})
