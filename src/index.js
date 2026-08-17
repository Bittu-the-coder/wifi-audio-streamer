import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, loadConfig, getLanAddresses, pickLanAddress, AUDIO_DIR, formatBytes } from './config.js'
import { Broadcaster } from './broadcaster.js'
import { FileSource } from './sources/file-source.js'
import { FfmpegSource, ffmpegAvailable } from './sources/ffmpeg-source.js'
import { generateTestWav } from './sources/wav-generator.js'
import { Segmenter } from './segmenter.js'
import { createAuth } from './auth.js'
import { createApp } from './server.js'
import { AudioWebSocketServer } from './websocket-server.js'

const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)

/** Parse ffmpeg bitrate strings like "128k" into bytes/second. */
function bitrateToBytesPerSecond(bitrate) {
  const m = String(bitrate).match(/^(\d+(?:\.\d+)?)\s*k?$/i)
  if (!m) return 16000
  return Math.round((Number(m[1]) * (m[0].toLowerCase().includes('k') ? 1000 : 1)) / 8)
}

loadDotEnv()
const config = loadConfig()
config.lanAddresses = getLanAddresses()

// URL shown to phones: explicit LAN_IP > concrete HOST bind IP > detected LAN IP
const primaryIp =
  config.lanIp ||
  (config.host !== '0.0.0.0' && isIp(config.host) ? config.host : null) ||
  pickLanAddress(config.lanAddresses) ||
  '127.0.0.1'
const primaryUrl = `http://${primaryIp}:${config.port}`

const auth = createAuth({ pin: config.pin, secret: config.authSecret })
const wsServer = new AudioWebSocketServer({ auth })
const broadcaster = new Broadcaster({ maxBacklog: config.maxBacklog, wsServer })

let source = null
let segmenter = null
let allowFallback = config.mode === 'auto'
let ffmpegAttempts = 0
let ffmpegRetryTimer = null
let ffmpegFirstDataTimer = null
let sawLiveData = false

const log = (...args) => console.log('[wifi-audio]', ...args)

/**
 * Attach a (new) source: fan its data out to the continuous stream AND feed
 * the live-edge segmenter. Rebuilds the segmenter so it matches the source's
 * format/rate.
 */
function bindSource(newSource) {
  source = newSource
  const info = newSource.info?.() ?? {}
  wsServer.setFormat(info)
  const bps =
    newSource instanceof FfmpegSource
      ? bitrateToBytesPerSecond(config.audioBitrate)
      : newSource.bytesPerSecond || 16000
  segmenter = new Segmenter({
    segmentMs: config.segmentMs,
    keep: config.keepSegments,
    bytesPerSecond: bps,
    header: newSource.headerChunk ?? null,
    contentType: info.contentType ?? 'audio/mpeg',
  })
  newSource.on('data', (c) => {
    broadcaster.push(c)
    segmenter.push(c)
  })
}

// ---------------------------------------------------------------------------
// Static (file-loop) mode
// ---------------------------------------------------------------------------

async function ensureTestAudioFile() {
  if (config.audioFile) {
    if (!fs.existsSync(config.audioFile)) {
      throw new Error(`AUDIO_FILE "${config.audioFile}" does not exist. Drop a .mp3/.wav there or remove AUDIO_FILE to use the generated test tone.`)
    }
    return config.audioFile
  }
  const mp3 = path.join(AUDIO_DIR, 'test.mp3')
  const wav = path.join(AUDIO_DIR, 'test.wav')
  if (fs.existsSync(mp3)) return mp3
  if (fs.existsSync(wav)) return wav
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  log('generating test audio…', path.relative(process.cwd(), wav))
  fs.writeFileSync(wav, generateTestWav({ seconds: config.testAudioSeconds }))
  return wav
}

async function startStaticSource() {
  const file = await ensureTestAudioFile()
  const s = new FileSource({ file, chunkSize: config.chunkSize, pace: config.pace })
  await s.start()
  bindSource(s)
  log(`static mode — looping ${path.basename(file)} (${s.duration.toFixed(1)}s loop)`)
}

// ---------------------------------------------------------------------------
// ffmpeg (live capture) mode
// ---------------------------------------------------------------------------

function startFfmpegSource() {
  const s = new FfmpegSource({
    ffmpegPath: config.ffmpegPath,
    device: config.captureDevice,
    bitrate: config.audioBitrate,
    bufferMs: config.audioBufferMs,
    sampleRate: config.sampleRate,
    channels: config.channels,
    frameMs: config.pcmFrameMs,
    volume: config.volume,
    extraArgs: config.ffmpegArgs,
  })
  s.on('error', ({ message, stderr }) => {
    log(`⚠ ffmpeg failed to start: ${message}`)
    if (stderr) log('  stderr:', stderr.trim().split('\n').pop())
    handleFfmpegFailure('error')
  })
  s.on('first-data', () => {
    clearTimeout(ffmpegFirstDataTimer)
    sawLiveData = true
    ffmpegAttempts = 0
    log(`live capture running — device "${config.captureDevice}"`)
  })
  s.on('exit', ({ sawData, stderr }) => {
    if (stderr) log('  ffmpeg stderr:', stderr.trim().split('\n').slice(-2).join(' | '))
    if (!sawData) handleFfmpegFailure('no-data')
    else {
      log('⚠ ffmpeg exited — restarting capture')
      restartFfmpeg()
    }
  })
  bindSource(s)
  s.start()

  clearTimeout(ffmpegFirstDataTimer)
  ffmpegFirstDataTimer = setTimeout(() => {
    if (!sawLiveData && source === s) handleFfmpegFailure('timeout')
  }, config.fallbackTimeoutMs)
}

function handleFfmpegFailure(reason) {
  if (!source) return
  if (allowFallback) {
    allowFallback = false
    const why =
      reason === 'timeout'
        ? 'ffmpeg started but no audio arrived from the capture device (wrong device name? nothing playing?)'
        : reason === 'no-data'
          ? 'ffmpeg exited without producing audio (check the device name and that VB-Cable is installed)'
          : 'ffmpeg could not be started (is it installed and on PATH?)'
    config.note = `Live capture unavailable — ${why}. Playing the test tone instead.`
    log(`⚠ live capture unavailable (${reason}) — falling back to static test audio`)
    if (source instanceof FfmpegSource) source.stop()
    startStaticSource().catch((err) => {
      log('✗ fallback failed:', err.message)
      process.exit(1)
    })
    return
  }
  restartFfmpeg()
}

function restartFfmpeg() {
  clearTimeout(ffmpegRetryTimer)
  const delay = Math.min(1000 * 2 ** Math.min(ffmpegAttempts, 5), 30000)
  ffmpegAttempts++
  log(`retrying live capture in ${(delay / 1000).toFixed(0)}s (attempt ${ffmpegAttempts})`)
  ffmpegRetryTimer = setTimeout(() => {
    if (source) source.stop()
    startFfmpegSource()
  }, delay)
}

// ---------------------------------------------------------------------------
// App / server
// ---------------------------------------------------------------------------

async function init() {
  let mode = config.mode
  if (mode === 'auto') {
    if (ffmpegAvailable(config.ffmpegPath)) {
      mode = 'ffmpeg'
    } else {
      mode = 'static'
      log('ffmpeg not found — using static test audio. Install ffmpeg + VB-Cable for live capture (see README).')
    }
  }
  config.mode = mode

  if (mode === 'ffmpeg') {
    startFfmpegSource()
  } else {
    try {
      await startStaticSource()
    } catch (err) {
      log('✗ could not start static source:', err.message)
      process.exit(1)
    }
  }

  const onVolumeChange = (v) => {
    if (source instanceof FfmpegSource) source.setVolume(v)
  }

  const app = createApp({ config, source, broadcaster, auth, primaryUrl, onVolumeChange, segmenter })
  const server = app.listen(config.port, config.host, () => {
    printBanner(server)
  })
  wsServer.attach(server)
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`✗ port ${config.port} is already in use — set PORT in .env to use another one.`)
      process.exit(1)
    }
    throw err
  })

  broadcaster.on('connect', (_id, n) => log(`📱 device joined — ${n} connected`))
  broadcaster.on('disconnect', (_id, n) => log(`📴 device left — ${n} connected`))

  setInterval(() => {
    if (broadcaster.count > 0) {
      log(`${broadcaster.count} device(s) connected · ${formatBytes(broadcaster.totalBytes)} streamed`)
    }
  }, 30000).unref()

  const shutdown = () => {
    log('shutting down…')
    if (source) source.stop()
    wsServer.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function printBanner(server) {
  const info = source?.info() ?? {}
  const lines = [
    '',
    '  🎧  WiFi Audio Stream',
    `     URL:      ${primaryUrl}`,
    `     Mode:     ${config.mode}${config.mode === 'static' ? ` (${info.detail ?? ''})` : ` — device "${config.captureDevice}"`}`,
    `     Stream:   ${info.contentType ?? 'n/a'} · ${info.format ?? ''}`,
    `     Clients:  0 connected`,
    `     Security: ${auth.enabled ? 'PIN-protected 🔒' : 'NO PIN — only run on a trusted WiFi network!'}`,
    '',
  ]
  console.log(lines.join('\n'))

  try {
    const { default: QRCode } = await import('qrcode')
    const qr = await QRCode.toString(primaryUrl, { type: 'terminal', small: true })
    console.log(`  Scan this QR from a phone on the same WiFi to join:\n\n${qr}\n`)
  } catch {
    /* qrcode not available — URL is printed above */
  }
}

init().catch((err) => {
  console.error('[wifi-audio] fatal:', err)
  process.exit(1)
})
