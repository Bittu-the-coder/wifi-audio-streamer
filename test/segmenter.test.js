import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Segmenter } from '../src/segmenter.js'

const BPS = 16000 // 128 kbps

test('splits a stream into fixed-duration segments', () => {
  const seg = new Segmenter({ segmentMs: 1000, keep: 8, bytesPerSecond: BPS })
  for (let i = 0; i < 6; i++) seg.push(Buffer.alloc(8000)) // 48 KB -> exactly 3s

  const m = seg.manifest()
  // 48,000 bytes / 16,000 Bps = 3s -> 3 full segments, liveId = 2
  assert.equal(m.liveId, 2)
  assert.equal(m.segments.length, 3)
  for (const s of m.segments) {
    assert.ok(Math.abs(s.dur - 1) < 0.01, `segment dur ${s.dur}`)
    const buf = seg.get(s.id)
    assert.ok(buf && buf.length >= 16000)
  }
})

test('keeps only the newest segments (ring eviction)', () => {
  const seg = new Segmenter({ segmentMs: 500, keep: 3, bytesPerSecond: BPS })
  for (let i = 0; i < 40; i++) seg.push(Buffer.alloc(8000)) // 20 KB -> ~2.5s -> 5 segments
  const m = seg.manifest()
  assert.ok(m.segments.length <= 3)
  const oldest = Math.min(...m.segments.map((s) => s.id))
  assert.equal(seg.get(oldest - 1), null, 'evicted segments must be gone')
})

test('WAV mode prepends the RIFF header to every segment', () => {
  const header = Buffer.from('RIFF____WAVEfmt ')
  const seg = new Segmenter({ segmentMs: 1000, keep: 4, bytesPerSecond: 176400, header, contentType: 'audio/wav' })
  for (let i = 0; i < 30; i++) seg.push(Buffer.alloc(44100)) // 1.32 MB -> ~7.5s -> 7 segments
  const m = seg.manifest()
  assert.ok(m.liveId >= 6)
  const buf = seg.get(m.liveId)
  assert.ok(buf.subarray(0, header.length).equals(header))
  assert.ok(Math.abs(m.segments.find((s) => s.id === m.liveId).dur - 1) < 0.02)
})

test('reset() starts a fresh epoch with numbering back at 0', () => {
  const seg = new Segmenter({ segmentMs: 1000, keep: 8, bytesPerSecond: BPS })
  for (let i = 0; i < 6; i++) seg.push(Buffer.alloc(8000))
  assert.equal(seg.manifest().liveId, 2)

  let resetEvents = 0
  seg.on('reset', () => resetEvents++)
  seg.reset()

  assert.equal(resetEvents, 1)
  assert.equal(seg.manifest().liveId, -1)
  assert.equal(seg.manifest().segments.length, 0)
  assert.equal(seg.get(0), null)

  seg.push(Buffer.alloc(8000))
  assert.equal(seg.manifest().liveId, -1, 'one chunk is not a full segment yet')
  seg.push(Buffer.alloc(8000)) // 16,000 bytes = exactly one 1s segment
  const m = seg.manifest()
  assert.equal(m.liveId, 0, 'numbering restarts at 0 after reset')
  assert.ok(seg.get(0))
})

test('manifest exposes content type and rates', () => {
  const seg = new Segmenter({ bytesPerSecond: BPS, contentType: 'audio/mpeg' })
  seg.push(Buffer.alloc(32000))
  const m = seg.manifest()
  assert.equal(m.contentType, 'audio/mpeg')
  assert.equal(m.bytesPerSecond, BPS)
  assert.equal(m.segmentMs, 1000)
})
