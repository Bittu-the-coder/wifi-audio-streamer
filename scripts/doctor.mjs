/**
 * Setup doctor — checks your whole capture chain and prints exactly what's
 * missing and how to fix it:
 *
 *   pnpm doctor
 */
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { loadConfig, loadDotEnv } from '../src/config.js'
import { parseDshowDevices } from './ffmpeg-devices.js'

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

// 2. FFmpeg --------------------------------------------------------------
const ffmpegResult = spawnSync(config.ffmpegPath, ['-version'], {
  windowsHide: true,
  timeout: 8000,
  encoding: 'utf8'
})
const ffmpegOk = ffmpegResult.status === 0
const ffmpegHint =
  process.platform === 'win32'
    ? 'Install FFmpeg with: winget install Gyan.FFmpeg'
    : 'Install FFmpeg with: sudo apt install ffmpeg'
check(ffmpegOk, `FFmpeg ${ffmpegOk ? 'available' : 'not available'} (${config.ffmpegPath})`, ffmpegHint)

// 3. Platform audio capture ----------------------------------------------
if (!ffmpegOk) {
  check(false, 'audio capture checks skipped because FFmpeg is unavailable')
} else if (process.platform === 'win32') {
  const usesDshow =
    config.captureFormat === 'dshow' ||
    (config.captureFormat === 'auto' &&
      config.captureDevice !== 'default' &&
      !config.captureDevice.toLowerCase().startsWith('wasapi'))
  if (!usesDshow) {
    check(true, 'WASAPI loopback will capture the default Windows output device')
  } else {
    const result = spawnSync(
      config.ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      {
        windowsHide: true,
        timeout: 15000,
        encoding: 'utf8'
      }
    )
    const devices = parseDshowDevices(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    const found = devices.includes(config.captureDevice)
    check(
      found,
      `DirectShow device "${config.captureDevice}" ${found ? 'found' : 'not found'}`,
      `FFmpeg sees: ${devices.join(', ') || '(no audio devices)'}`
    )
  }
} else if (process.platform === 'linux') {
  const devices = spawnSync(config.ffmpegPath, ['-hide_banner', '-devices'], {
    encoding: 'utf8',
    timeout: 8000
  })
  const hasPulseInput = /\bpulse\b/i.test(`${devices.stdout ?? ''}\n${devices.stderr ?? ''}`)
  check(
    hasPulseInput,
    `FFmpeg PulseAudio input ${hasPulseInput ? 'available' : 'unavailable'}`,
    'Install an FFmpeg build with PulseAudio support.'
  )

  const defaultSink = spawnSync('pactl', ['get-default-sink'], {
    encoding: 'utf8',
    timeout: 5000
  })
  const sources = spawnSync('pactl', ['list', 'short', 'sources'], {
    encoding: 'utf8',
    timeout: 5000
  })
  const sink = defaultSink.status === 0 ? defaultSink.stdout.trim() : ''
  const monitor = sink.endsWith('.monitor') ? sink : `${sink}.monitor`
  const monitorFound =
    Boolean(sink) &&
    sources.status === 0 &&
    sources.stdout.split(/\r?\n/).some((line) => line.includes(monitor))
  check(
    monitorFound,
    `default output monitor ${monitorFound ? 'available' : 'not found'}`,
    'Install pulseaudio-utils and ensure PipeWire/PulseAudio is running: sudo apt install pulseaudio-utils'
  )
} else {
  check(false, `automatic system-audio capture is unsupported on ${process.platform}`)
}

// 5. Port ----------------------------------------------------------------
await new Promise((resolve) => {
  const srv = net.createServer()
  srv.once('error', () => {
    check(
      false,
      `port ${config.port} is free`,
      'Another program is using it — set PORT in .env, or stop that program.'
    )
    resolve()
  })
  srv.once('listening', () => {
    srv.close(() => {
      check(true, `port ${config.port} is free`)
      resolve()
    })
  })
  srv.listen(config.port, '127.0.0.1')
})

// 6. Summary --------------------------------------------------------------
console.log('')
const failed = results.filter((r) => !r.ok)

if (failed.length === 0) {
  console.log('  ✅ Everything looks ready — run:  pnpm start')
  console.log(`     Phones open:  http://<this-laptop-ip>:${config.port}`)
} else {
  console.log(`  ⚠  ${failed.length} issue(s) found — fix them, then run:  pnpm start`)
}
console.log('')
process.exit(failed.length ? 1 : 0)
