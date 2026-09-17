import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const PUBLIC_DIR = path.join(ROOT, 'src', 'public')
export const AUDIO_DIR = path.join(ROOT, 'audio')

/**
 * Tiny .env loader (no dependency). Existing process.env vars win.
 */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || m[1] === '') continue
    const [, key, value] = m
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function float(value, fallback) {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * All non-internal IPv4 addresses of this machine (LAN IPs), with adapter
 * names. Virtual adapters (WSL, Hyper-V, VPNs…) are useless for phones, so
 * they're excluded.
 */
export function getLanInterfaces() {
  const out = []
  const virtualRe = /wsl|vethernet|hyper-v|virtual|loopback|vmware/i
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (virtualRe.test(name)) continue
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({ name, address: iface.address })
      }
    }
  }
  return out
}

export function getLanAddresses() {
  return getLanInterfaces().map((i) => i.address)
}

/**
 * Pick the most likely "phone-connectable" address: prefer private ranges.
 */
export function pickLanAddress(addresses = getLanAddresses()) {
  const isPrivate = (a) => {
    const [x, y] = a.split('.').map(Number)
    return x === 10 || x === 172 && y >= 16 && y <= 31 || x === 192 && y === 168
  }
  return addresses.find(isPrivate) ?? addresses[0] ?? '127.0.0.1'
}

export function loadConfig(env = process.env) {
  const mode = (env.MODE || 'auto').toLowerCase()
  if (!['auto', 'static', 'ffmpeg'].includes(mode)) {
    throw new Error(`Invalid MODE "${mode}" — use auto, static or ffmpeg`)
  }

  const port = int(env.PORT, 8080)
  const host = env.HOST || '0.0.0.0'

  return {
    port,
    host,
    // Explicit override for the URL/QR shown to phones (defaults to the
    // detected LAN IP). Useful if detection picks the wrong adapter.
    lanIp: env.LAN_IP || '',
    mode,
    // Static-file mode
    audioFile: env.AUDIO_FILE || '', // '' => auto-pick (test.mp3, test.wav, or generate)
    testAudioSeconds: int(env.TEST_AUDIO_SECONDS, 4),
    // ffmpeg capture mode
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    captureDevice: env.CAPTURE_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)',
    audioBitrate: env.AUDIO_BITRATE || '128k',
    audioBufferMs: int(env.AUDIO_BUFFER_MS, 100),
    volume: float(env.VOLUME, 1),
    ffmpegArgs: env.FFMPEG_ARGS ? env.FFMPEG_ARGS.trim().split(/\s+/) : [],
    // Security
    pin: env.AUTH_PIN || '',
    authSecret: env.AUTH_SECRET || '',
    // Streaming internals
    chunkSize: int(env.CHUNK_SIZE, 16384),
    maxBacklog: int(env.MAX_BACKLOG, 512 * 1024), // per-client drop threshold (bytes)
    // Live-edge segmentation (phones stay in sync by playing the same segment)
    segmentMs: int(env.SEGMENT_MS, 1000),
    liveEdge: int(env.LIVE_EDGE, 1), // segments behind the live edge clients start at
    keepSegments: int(env.KEEP_SEGMENTS, 16),
    syncLeadMs: int(env.SYNC_LEAD_MS, 2500), // "Sync start": time before the epoch begins
    fallbackTimeoutMs: int(env.FALLBACK_TIMEOUT, 6000), // auto-mode: wait for first ffmpeg data
    bufferTarget: float(env.BUFFER_TARGET, 1.2), // seconds of buffered audio before client plays
    pace: float(env.PACE, 1.04), // static loop runs slightly faster than real-time
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
