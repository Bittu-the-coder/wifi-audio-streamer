/**
 * List the DirectShow audio capture devices ffmpeg can see on Windows.
 * Handy for finding the exact device name for CAPTURE_DEVICE:
 *
 *   pnpm list:devices
 *   node scripts/list-audio-devices.mjs [path-to-ffmpeg]
 */
import { spawnSync } from 'node:child_process'
import { parseDshowDevices } from './doctor.mjs'

const ffmpeg = process.argv[2] || 'ffmpeg'
console.log(`Listing audio devices via "${ffmpeg}" …\n`)

const r = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15000,
})

const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
if (!out.trim()) {
  console.log('No output — is ffmpeg installed and on PATH? (install: winget install Gyan.FFmpeg)')
  process.exit(1)
}

const devices = parseDshowDevices(out)
if (devices.length) {
  console.log('Audio capture devices found:')
  for (const name of devices) console.log(`  - ${name}`)
  console.log('\nPick one (e.g. "CABLE Output (VB-Audio Virtual Cable)" or "Stereo Mix")')
  console.log('and set it in .env as:  CAPTURE_DEVICE=<exact name>')
} else {
  console.log(out)
  console.log('\nNo audio devices found — install VB-Audio Virtual Cable, or enable "Stereo Mix"')
  console.log('in Windows Sound settings (Sound > Recording > enable Stereo Mix).')
}
