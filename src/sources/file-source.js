import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { parseWav } from './wav-generator.js'

/**
 * Static-file source: loops a WAV or MP3 file in real time on a shared clock.
 *
 * All connected clients receive the SAME paced stream, so phones that join
 * around the same time are roughly in sync (radio-style). The loop runs even
 * with zero clients so the loop phase keeps advancing and late joiners hear
 * the current position, not the file start.
 *
 * For WAV files (which need their RIFF header at the start of a connection),
 * the source keeps a ring buffer of the last full loop and hands new clients
 * a valid "join chunk": header + data from the current loop position.
 */

const MPEG1 = 3
const MPEG2 = 2
const MPEG25 = 0

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const BITRATE_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0]
const BITRATE_V2_L2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATE_V1 = [44100, 48000, 32000]
const SAMPLE_RATE_V2 = [22050, 24000, 16000]
const SAMPLE_RATE_V25 = [11025, 12000, 8000]

/**
 * Walk an MP3 buffer and return [{ offset, len, duration }] for every valid
 * frame. Frame-accurate so the loop point is clean and chunk splits never cut
 * a frame in half. Skips ID3v2 tags naturally (they aren't frames).
 */
export function parseMp3Frames(buf) {
  const frames = []
  let i = 0
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const version = (buf[i + 1] >> 3) & 0x3
      const layer = (buf[i + 1] >> 1) & 0x3 // 1=III, 2=II, 3=I
      const brIdx = (buf[i + 2] >> 4) & 0xf
      const srIdx = (buf[i + 2] >> 2) & 0x3
      const padding = (buf[i + 2] >> 1) & 0x1

      const valid =
        version !== 1 && // version 1 is reserved
        layer !== 0 && // layer 0 is reserved
        brIdx !== 0 && brIdx !== 15 && // free/reserved bitrates
        srIdx !== 3 // sample rate 3 is reserved

      if (valid) {
        const bitrate =
          (layer === 1 ? (version === MPEG1 ? BITRATE_V1_L3 : BITRATE_V2_L3) : version === MPEG1 ? BITRATE_V1_L2 : BITRATE_V2_L2)[brIdx] * 1000
        const sampleRates = version === MPEG1 ? SAMPLE_RATE_V1 : version === MPEG2 ? SAMPLE_RATE_V2 : SAMPLE_RATE_V25
        const sr = sampleRates[srIdx]
        const samples = layer === 3 ? 384 : version === MPEG1 ? 1152 : 576
        const frameLen =
          layer === 3
            ? Math.floor((12 * bitrate) / sr + padding) * 4
            : Math.floor((144 * bitrate) / sr) + padding

        if (frameLen > 0 && i + frameLen <= buf.length) {
          frames.push({ offset: i, len: frameLen, duration: samples / sr })
          i += frameLen
          continue
        }
      }
    }
    i++
  }
  return frames
}

export class FileSource extends EventEmitter {
  constructor({ file, chunkSize = 16384, pace = 1.04 } = {}) {
    super()
    this.file = file
    this.chunkSize = chunkSize
    this.pace = pace
    this.stopped = false
    this.state = 'idle'
    this.headerChunk = null // WAV RIFF header (emitted once per connection)
    this.chunks = [] // loop payload, split into whole-frame chunks
    this.bytesPerSecond = 0
    this.duration = 0
    this.contentType = null
    this.format = null

    this.ring = [] // recent emitted chunks (WAV only), capped at one full loop
    this.ringBytes = 0
    this.loopPos = 0 // bytes into the current loop iteration
    this.posBytes = 0 // total bytes emitted since start (pacing clock)
    this.chunkIndex = 0
  }

  /** Load the file and start the paced loop. Resolves once started. */
  async start() {
    const buf = await fs.promises.readFile(this.file)
    const ext = path.extname(this.file).toLowerCase()

    if (ext === '.wav' || buf.toString('ascii', 0, 4) === 'RIFF') {
      this._initWav(buf)
    } else if (ext === '.mp3' || ext === '.mpga' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
      this._initMp3(buf)
    } else {
      throw new Error(`Unsupported audio file: ${this.file} (use .wav or .mp3)`)
    }

    this.state = 'running'
    this.startedAt = Date.now()
    this._tick()
    this.emit('started')
    return this
  }

  _initWav(buf) {
    const { fmt, dataOffset, dataSize } = parseWav(buf)
    const frameBytes = fmt.blockAlign || fmt.channels * 2
    const usable = dataSize - (dataSize % frameBytes) // trim a trailing partial frame
    const header = buf.subarray(0, dataOffset)

    const chunks = []
    const target = this.chunkSize - (this.chunkSize % frameBytes)
    let i = dataOffset
    while (i < dataOffset + usable) {
      const len = Math.min(target, dataOffset + usable - i)
      chunks.push(buf.subarray(i, i + len))
      i += len
    }
    if (!chunks.length) throw new Error('WAV file contains no audio data')

    this.headerChunk = Buffer.from(header)
    this.chunks = chunks
    this.loopBytes = usable
    this.bytesPerSecond = fmt.byteRate
    this.duration = usable / fmt.byteRate
    this.contentType = 'audio/wav'
    this.format = `${fmt.sampleRate} Hz, ${fmt.channels}ch, ${fmt.bits}-bit PCM`
  }

  _initMp3(buf) {
    const frames = parseMp3Frames(buf)
    if (!frames.length) throw new Error('No MP3 frames found — is this really an MP3 file?')

    const chunks = []
    let group = []
    let groupBytes = 0
    let totalBytes = 0
    let totalDuration = 0
    for (const f of frames) {
      if (groupBytes + f.len > this.chunkSize && group.length) {
        chunks.push(Buffer.concat(group))
        group = []
        groupBytes = 0
      }
      group.push(buf.subarray(f.offset, f.offset + f.len))
      groupBytes += f.len
      totalBytes += f.len
      totalDuration += f.duration
    }
    if (group.length) chunks.push(Buffer.concat(group))

    this.chunks = chunks
    this.loopBytes = totalBytes
    this.bytesPerSecond = totalBytes / totalDuration
    this.duration = totalDuration
    this.contentType = 'audio/mpeg'
    this.format = `MPEG-1/2 Layer II/III, ${this.duration.toFixed(1)}s, ~${Math.round(this.bytesPerSecond * 8 / 1000)} kbps`
  }

  /**
   * A valid chunk for a brand-new client: for WAV, the RIFF header followed by
   * the data from the current loop position (via the ring buffer). For MP3,
   * nothing is needed — the stream is self-synchronizing.
   */
  joinChunk() {
    if (this.contentType !== 'audio/wav') return null
    if (!this.ring.length) return this.headerChunk ? Buffer.from(this.headerChunk) : null
    const tailBytes = Math.max(0, this.loopBytes - this.loopPos)
    const parts = []
    let have = 0
    for (let k = this.ring.length - 1; k >= 0 && have < tailBytes; k--) {
      const c = this.ring[k]
      const take = Math.min(c.length, tailBytes - have)
      parts.unshift(take === c.length ? c : c.subarray(c.length - take))
      have += take
    }
    return Buffer.concat([this.headerChunk, ...parts])
  }

  _tick() {
    if (this.stopped) return
    const elapsed = (Date.now() - this.startedAt) / 1000
    const targetBytes = elapsed * this.bytesPerSecond * this.pace

    while (this.posBytes < targetBytes && this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]
      this.posBytes += chunk.length
      this.loopPos = (this.loopPos + chunk.length) % this.loopBytes
      this.chunkIndex = (this.chunkIndex + 1) % this.chunks.length
      this._push(chunk)
    }

    // How far ahead/behind the clock we are -> schedule the next tick.
    const drift = targetBytes - this.posBytes
    const waitMs = Math.max(8, (drift / this.bytesPerSecond) * 1000)
    this.timer = setTimeout(() => this._tick(), waitMs)
  }

  _push(chunk) {
    if (this.contentType === 'audio/wav') {
      this.ring.push(chunk)
      this.ringBytes += chunk.length
      while (this.ringBytes - this.ring[0].length >= this.loopBytes) {
        this.ringBytes -= this.ring[0].length
        this.ring.shift()
      }
    }
    this.emit('data', chunk)
  }

  /** Rewind the loop to position 0 (used by the host's "Sync start"). */
  restart() {
    if (this.state !== 'running') return
    this.startedAt = Date.now()
    this.posBytes = 0
    this.loopPos = 0
    this.chunkIndex = 0
    this.ring = []
    this.ringBytes = 0
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.state = 'stopped'
  }

  info() {
    return {
      type: 'file',
      detail: path.basename(this.file),
      file: this.file,
      format: this.format,
      loopSeconds: Number(this.duration.toFixed(2)),
      contentType: this.contentType,
      state: this.state,
    }
  }
}
