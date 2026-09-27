import { EventEmitter } from 'node:events'
import { buildWavBuffer } from './sources/wav-generator.js'

/**
 * Splits the continuous audio stream into short, independently-playable
 * segments (mini-HLS). Clients follow the "live edge" — everyone plays the
 * same current segment — which is what keeps phones in sync even when they
 * join at different times.
 *
 * MP3 segments are raw MP3 bytes (decoders self-synchronize). WAV segments
 * get the RIFF header prepended so each one is a valid standalone file.
 */
export class Segmenter extends EventEmitter {
  constructor({
    segmentMs = 1000,
    keep = 16,
    bytesPerSecond = 16000,
    header = null, // WAV header to prepend to every segment (null for MP3)
    wavFormat = null,
    playoutDelayMs = 400,
    contentType = 'audio/mpeg'
  } = {}) {
    super()
    this.segmentMs = segmentMs
    this.keep = keep
    this.bytesPerSecond = bytesPerSecond
    this.header = header
    this.wavFormat = wavFormat
    this.playoutDelayMs = playoutDelayMs
    this.contentType = contentType
    const alignment = wavFormat ? (wavFormat.channels * wavFormat.bits) / 8 : 1
    this.frameAlignment = alignment
    this.pendingBytes = Buffer.alloc(0)
    const targetBytes = Math.max(alignment, Math.round((bytesPerSecond * segmentMs) / 1000))
    this.segmentBytes = Math.max(alignment, targetBytes - (targetBytes % alignment))

    this.segments = new Map() // id -> Buffer
    this.ids = [] // ordered ids
    this.current = null
    this.nextId = 0
  }

  push(chunk) {
    if (this.frameAlignment > 1) {
      if (this.pendingBytes.length) {
        chunk = Buffer.concat([this.pendingBytes, chunk])
        this.pendingBytes = Buffer.alloc(0)
      }
      const alignedLength = chunk.length - (chunk.length % this.frameAlignment)
      this.pendingBytes = chunk.subarray(alignedLength)
      chunk = chunk.subarray(0, alignedLength)
    }

    let offset = 0
    while (offset < chunk.length) {
      if (!this.current) this.current = { id: this.nextId, parts: [], bytes: 0 }
      const length = Math.min(this.segmentBytes - this.current.bytes, chunk.length - offset)
      this.current.parts.push(chunk.subarray(offset, offset + length))
      this.current.bytes += length
      offset += length
      if (this.current.bytes === this.segmentBytes) this._finalize()
    }
  }

  _finalize() {
    const c = this.current
    const payload = Buffer.concat(c.parts, c.bytes)
    const buf = this.wavFormat
      ? buildWavBuffer({ pcm: payload, ...this.wavFormat })
      : this.header
        ? Buffer.concat([this.header, payload])
        : payload
    this.segments.set(c.id, {
      data: buf,
      playAt: Date.now() + this.playoutDelayMs
    })
    this.ids.push(c.id)
    while (this.ids.length > this.keep) this.segments.delete(this.ids.shift())
    this.current = null
    this.nextId += 1
    this.emit('segment', c.id)
  }

  /** Id of the most recently completed segment (the live edge). */
  liveId() {
    return this.nextId - 1
  }

  manifest() {
    const segments = this.ids.map((id) => ({
      id,
      dur: this._duration(id),
      playAt: this.schedule(id)
    }))
    return {
      liveId: this.nextId - 1,
      segments,
      contentType: this.contentType,
      segmentMs: this.segmentMs,
      bytesPerSecond: this.bytesPerSecond,
      playoutDelayMs: this.playoutDelayMs,
      scheduledPlayback: Boolean(this.wavFormat)
    }
  }

  /** Start a fresh epoch: drop all segments and restart numbering at 0. */
  reset() {
    this.segments = new Map()
    this.ids = []
    this.current = null
    this.pendingBytes = Buffer.alloc(0)
    this.nextId = 0
    this.emit('reset')
  }

  get(id) {
    return this.segments.get(Number(id))?.data ?? null
  }

  schedule(id) {
    return this.segments.get(Number(id))?.playAt ?? null
  }

  _duration(id) {
    const segment = this.segments.get(id)
    if (!segment) return this.segmentMs / 1000
    const buf = segment.data
    const headerBytes = this.wavFormat ? 44 : this.header ? this.header.length : 0
    const payload = buf.length - headerBytes
    return payload / this.bytesPerSecond
  }
}
