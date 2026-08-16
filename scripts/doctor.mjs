/**
 * Setup doctor — checks your whole capture chain and prints exactly what's
 * missing and how to fix it:
 *
 *   pnpm doctor
 */
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { loadDotEnv, loadConfig } from '../src/config.js'

const results = []
const check = (ok, label, hint = '') => {
  results.push({ ok, label, hint })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && hint ? `\n      → ${hint}` : ''}`)
}

console.log('\n🧰  WiFi Audio Stream — setup doctor\n')

loadDotEnv()
let config
try {
  config = loadConfig()
} catch (err) {
  console.log(`  ✗ config error: ${err.message}`)
  process.exit(1)
}

// 1. Node ----------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0])
check(nodeMajor >= 20, `Node.js ${process.versions.node} (need ≥ 20)`)

// 2. ffmpeg --------------------------------------------------------------
let ffmpegOk = false
if (config.ffmpegPath !== 'ffmpeg') {
  const r = spawnSync(config.ffmpegPath, ['-version'], { windowsHide: true, timeout: 8000, encoding: 'utf8' })
  ffmpegOk = r.status === 0
  check(ffmpegOk, `ffmpeg at FFMPEG_PATH "${config.ffmpegPath}"`, `File not found or not runnable. Set FFMPEG_PATH to the full ffmpeg.exe path.`)
} else {
  const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 8000, encoding: 'utf8' })
  ffmpegOk = r.status === 0 && (r.stdout || '').length > 0
  check(ffmpegOk, 'ffmpeg installed and on PATH', 'Install it:  winget install Gyan.FFmpeg   (then open a NEW terminal)')
}

// 3. Capture devices (via ffmpeg dshow listing) --------------------------
let captureDevices = []
if (ffmpegOk) {
  const r = spawnSync(config.ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    windowsHide: true, timeout: 15000, encoding: 'utf8',
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  captureDevices = parseDshowDevices(out)

  const found = captureDevices.some((d) => d === config.captureDevice)
  check(found, `capture device "${config.captureDevice}" found`, `ffmpeg sees: ${captureDevices.join(', ') || '(no audio devices)'}. Pick one and set CAPTURE_DEVICE in .env, or install VB-Audio Virtual Cable.`)
} else {
  check(false, `capture device "${config.captureDevice}" (skipped — ffmpeg missing)`)
}

// 4. VB-Cable endpoints (via PowerShell) ----------------------------------
try {
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    'Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName',
  ], { windowsHide: true, timeout: 15000, encoding: 'utf8' })
  const endpoints = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const hasCable = endpoints.some((e) => /cable/i.test(e))
  check(hasCable, 'VB-Audio Virtual Cable installed', 'Download & install from https://vb-audio.com/Cable/ (free), then reboot or replug.')
  if (endpoints.length) console.log(`      Devices: ${endpoints.join(' | ')}`)
} catch {
  check(false, 'could not query Windows audio devices')
}

// 5. Port ----------------------------------------------------------------
await new Promise((resolve) => {
  const srv = net.createServer()
  srv.once('error', () => { check(false, `port ${config.port} is free`, 'Another program is using it — set PORT in .env, or stop that program.'); resolve() })
  srv.once('listening', () => { srv.close(() => { check(true, `port ${config.port} is free`); resolve() }) })
  srv.listen(config.port, '127.0.0.1')
})

// 6. Summary --------------------------------------------------------------
console.log('')
const failed = results.filter((r) => !r.ok)

/**
 * Parse dshow device names from ffmpeg's -list_devices output.
 * Handles both the modern format ("Name" (audio)) and legacy (audio="Name").
 */
export function parseDshowDevices(out) {
  const devices = []
  const re = /"([^"]+)"\s+\((audio|video)\)/g
  let m
  while ((m = re.exec(out))) {
    if (m[2] === 'audio') devices.push(m[1])
  }
  if (!devices.length) {
    const legacy = /audio="([^"]+)"/g
    while ((m = legacy.exec(out))) devices.push(m[1])
  }
  return devices
}
if (failed.length === 0) {
  console.log('  ✅ Everything looks ready — run:  pnpm start')
  console.log(`     Phones open:  http://<this-laptop-ip>:${config.port}`)
} else {
  console.log(`  ⚠  ${failed.length} issue(s) found — fix them, then run:  pnpm start`)
}
console.log('')
process.exit(failed.length ? 1 : 0)
