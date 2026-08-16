import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileSource, parseMp3Frames } from '../src/sources/file-source.js'
import { generateTestWav } from '../src/sources/wav-generator.js'

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-audio-')), name)

function mp3Frame(bitrateIdx = 9, srIdx = 0, padding = 0) {
  // MPEG1 Layer III, no CRC: FF FB, then brIdx/srIdx/padding, then 0x00
  return Buffer.from([0xff, 0xfb, (bitrateIdx << 4) | (srIdx << 2) | (padding << 1), 0x00])
}

test('parseMp3Frames finds whole frames and skips garbage', () => {
  const header = mp3Frame(9) // 128 kbps, 44.1 kHz -> 417 bytes/frame
  const frameLen = 417
  const junk = Buffer.from([0xff, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // 0x41 & 0xE0 != 0xE0
  const body = Buffer.alloc(frameLen - 4)
  const buf = Buffer.concat([junk, header, body, header, body, header, body])

  const frames = parseMp3Frames(buf)
  assert.equal(frames.length, 3)
  assert.equal(frames[0].offset, junk.length)
  assert.equal(frames[1].offset, junk.length + frameLen)
  assert.equal(frames[2].offset, junk.length + frameLen * 2)
  assert.ok(frames.every((f) => f.len === frameLen && f.duration > 0))
})

test('parseMp3Frames handles 64 kbps frames (different bitrate)', () => {
  const header = mp3Frame(5) // 64 kbps, 44.1 kHz -> 208 bytes/frame
  const frameLen = 208
  const body = Buffer.alloc(frameLen - 4)
  const buf = Buffer.concat([header, body, header, body])
  const frames = parseMp3Frames(buf)
  assert.equal(frames.length, 2)
  assert.ok(frames.every((f) => f.len === frameLen))
})

test('FileSource loops a WAV in real time with frame-aligned chunks', async () => {
  const file = tmp('test.wav')
  fs.writeFileSync(file, generateTestWav({ seconds: 1 }))

  const source = new FileSource({ file, chunkSize: 16384, pace: 1.04 })
  const emitted = []
  source.on('data', (c) => emitted.push(c))
  await source.start()

  assert.equal(source.contentType, 'audio/wav')
  assert.equal(source.loopBytes, 44100 * 4)
  assert.ok(Math.abs(source.duration - 1) < 0.01)

  await new Promise((r) => setTimeout(r, 450))
  source.stop()

  const total = emitted.reduce((n, c) => n + c.length, 0)
  // ~0.45s of audio at 176.4 KB/s, paced at 1.04x -> ~82 KB; allow generous slack
  assert.ok(total > 30_000 && total < 200_000, `unexpected byte count: ${total}`)

  // Every chunk must be whole 16-bit stereo frames (multiple of 4 bytes)
  for (const c of emitted) assert.equal(c.length % 4, 0)

  // Several chunks should have been emitted (exact count depends on timing)
  assert.ok(emitted.length > 2, 'expected several chunks')
})

test('FileSource joinChunk returns a valid WAV header + data for new clients', async () => {
  const file = tmp('test.wav')
  fs.writeFileSync(file, generateTestWav({ seconds: 1 }))

  const source = new FileSource({ file, chunkSize: 16384, pace: 1.04 })
  source.on('data', () => {})
  await source.start()
  await new Promise((r) => setTimeout(r, 700)) // let it run past one full loop
  const join = source.joinChunk()
  source.stop()

  assert.ok(join, 'joinChunk should not be null for WAV')
  assert.equal(join.toString('ascii', 0, 4), 'RIFF')
  assert.ok(join.length > 44, 'joinChunk must contain audio data after the header')
  assert.ok(join.length <= 44 + source.loopBytes, 'joinChunk must not exceed one loop')
})

test('FileSource streams an MP3 starting at a frame boundary', async () => {
  const header = mp3Frame(9)
  const frameLen = 417
  const body = Buffer.alloc(frameLen - 4)
  const frames = 20
  const parts = []
  for (let i = 0; i < frames; i++) parts.push(header, body)
  const file = tmp('test.mp3')
  fs.writeFileSync(file, Buffer.concat(parts))

  const source = new FileSource({ file, chunkSize: 4096, pace: 1.1 })
  const emitted = []
  source.on('data', (c) => emitted.push(c))
  await source.start()

  assert.equal(source.contentType, 'audio/mpeg')
  assert.ok(source.duration > 0.3, `expected ~0.52s of audio, got ${source.duration}`)

  await new Promise((r) => setTimeout(r, 300))
  source.stop()

  assert.ok(emitted.length > 0, 'should have emitted chunks')
  const first = emitted[0]
  assert.equal(first[0], 0xff)
  assert.equal(first[1] & 0xe0, 0xe0) // starts at a sync word (frame boundary)
  // joinChunk is not needed for MP3
  assert.equal(source.joinChunk(), null)
})

test('FileSource rejects unsupported files', async () => {
  const file = tmp('test.xyz')
  fs.writeFileSync(file, 'definitely not audio')
  const source = new FileSource({ file })
  await assert.rejects(source.start(), /Unsupported audio file/)
})
