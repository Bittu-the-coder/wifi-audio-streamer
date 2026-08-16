import { EventEmitter } from 'node:events'

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
    contentType = 'audio/mpeg',
  } = {}) {
    super()
    this.segmentMs = segmentMs
    this.keep = keep
    this.bytesPerSecond = bytesPerSecond
    this.header = header
    this.contentType = contentType
    this.segmentBytes = Math.max(512, Math.round((bytesPerSecond * segmentMs) / 1000))

    this.segments = new Map() // id -> Buffer
    this.ids = [] // ordered ids
    this.current = null
    this.nextId = 0
  }

  push(chunk) {
    if (!this.current) this.current = { id: this.nextId, parts: [], bytes: 0 }
    this.current.parts.push(chunk)
    this.current.bytes += chunk.length
    if (this.current.bytes >= this.segmentBytes) this._finalize()
  }

  _finalize() {
    const c = this.current
    const payload = Buffer.concat(c.parts, c.bytes)
    const buf = this.header ? Buffer.concat([this.header, payload]) : payload
    this.segments.set(c.id, buf)
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
    }))
    return {
      liveId: this.nextId - 1,
      segments,
      contentType: this.contentType,
      segmentMs: this.segmentMs,
      bytesPerSecond: this.bytesPerSecond,
    }
  }

  /** Start a fresh epoch: drop all segments and restart numbering at 0. */
  reset() {
    this.segments = new Map()
    this.ids = []
    this.current = null
    this.nextId = 0
    this.emit('reset')
  }

  get(id) {
    const buf = this.segments.get(Number(id))
    return buf ?? null
  }

  _duration(id) {
    const buf = this.segments.get(id)
    if (!buf) return this.segmentMs / 1000
    const payload = buf.length - (this.header ? this.header.length : 0)
    return payload / this.bytesPerSecond
  }
}
