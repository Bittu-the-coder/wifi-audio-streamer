/**
 * List the DirectShow audio capture devices ffmpeg can see on Windows.
 * Handy for finding the exact device name for CAPTURE_DEVICE:
 *
 *   pnpm list:devices
 *   node scripts/list-audio-devices.mjs [path-to-ffmpeg]
 */
import { spawnSync } from 'node:child_process'
import { parseDshowDevices } from './ffmpeg-devices.js'

const ffmpeg = process.argv[2] || 'ffmpeg'
console.log(`Listing audio capture sources via "${ffmpeg}"…\n`)

if (process.platform === 'win32') {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.trim()) {
    console.log('No output — install FFmpeg and ensure it is on PATH.')
    process.exit(1)
  }
  const devices = parseDshowDevices(output)
  if (devices.length) {
    console.log('DirectShow audio devices:')
    for (const device of devices) console.log(`  - ${device}`)
    console.log('\nUse CAPTURE_FORMAT=dshow and set CAPTURE_DEVICE to an exact name.')
    console.log('For system output loopback, leave CAPTURE_FORMAT=auto and CAPTURE_DEVICE=default.')
  } else {
    console.log(output)
    console.log('\nNo DirectShow capture devices found. WASAPI loopback may still capture system output.')
  }
} else if (process.platform === 'linux') {
  const result = spawnSync('pactl', ['list', 'short', 'sources'], {
    encoding: 'utf8',
    timeout: 5000
  })
  if (result.status !== 0) {
    console.log(
      'Could not list PulseAudio/PipeWire sources. Install pulseaudio-utils and check that audio is running.'
    )
    process.exit(1)
  }
  const sources = (result.stdout || '').split(/\r?\n/).filter(Boolean)
  const sink = spawnSync('pactl', ['get-default-sink'], {
    encoding: 'utf8',
    timeout: 5000
  })
  const defaultSink = sink.status === 0 ? sink.stdout.trim() : ''
  console.log('PulseAudio/PipeWire sources:')
  for (const source of sources) console.log(`  ${source.trim().split(/\s+/).slice(0, 2).join(' ')}`)
  if (defaultSink) {
    const monitor = defaultSink.endsWith('.monitor') ? defaultSink : `${defaultSink}.monitor`
    console.log(`\nDefault output monitor: ${monitor}`)
  }
  console.log(
    'Use CAPTURE_FORMAT=pulse and set CAPTURE_DEVICE to the monitor name, or leave both at auto/default.'
  )
} else {
  console.log(`Automatic device listing is not supported on ${process.platform}.`)
  process.exit(1)
}
