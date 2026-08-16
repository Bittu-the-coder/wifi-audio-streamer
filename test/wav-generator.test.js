import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateTestWav, buildWavBuffer, parseWav } from '../src/sources/wav-generator.js'

test('generateTestWav produces a valid 16-bit stereo WAV of the requested length', () => {
  const seconds = 2
  const buf = generateTestWav({ seconds })
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE')

  const { fmt, dataOffset, dataSize } = parseWav(buf)
  assert.equal(fmt.audioFormat, 1) // PCM
  assert.equal(fmt.channels, 2)
  assert.equal(fmt.sampleRate, 44100)
  assert.equal(fmt.bits, 16)
  assert.equal(fmt.blockAlign, 4)
  assert.equal(fmt.byteRate, 44100 * 4)

  const expectedData = seconds * 44100 * 4
  assert.equal(dataSize, expectedData)
  assert.equal(dataOffset, 44)
  assert.equal(buf.length, 44 + expectedData)

  // Whole file must be exactly header + data
  assert.equal(buf.length, 44 + dataSize)
})

test('the loop point is click-free (starts and ends near zero)', () => {
  const buf = generateTestWav({ seconds: 1 })
  const { dataOffset, dataSize, fmt } = parseWav(buf)
  const frameBytes = fmt.blockAlign
  const lastFrame = buf.readInt16LE(dataOffset + dataSize - frameBytes)
  const firstFrame = buf.readInt16LE(dataOffset)
  assert.ok(Math.abs(firstFrame) < 2000, `first sample too loud: ${firstFrame}`)
  assert.ok(Math.abs(lastFrame) < 500, `last sample not at zero crossing: ${lastFrame}`)
})

test('audio is not silent (some energy present)', () => {
  const buf = generateTestWav({ seconds: 1 })
  const { dataOffset, dataSize } = parseWav(buf)
  let peak = 0
  for (let off = dataOffset; off < dataOffset + dataSize; off += 2) {
    peak = Math.max(peak, Math.abs(buf.readInt16LE(off)))
  }
  assert.ok(peak > 5000, `peak amplitude too low: ${peak}`)
})

test('buildWavBuffer wraps raw PCM correctly', () => {
  const pcm = Buffer.alloc(44100 * 4) // 1 second of silence, 16-bit stereo
  const buf = buildWavBuffer({ pcm, sampleRate: 44100, channels: 2, bits: 16 })
  assert.equal(buf.length, 44 + pcm.length)
  const parsed = parseWav(buf)
  assert.equal(parsed.dataSize, pcm.length)
  assert.equal(parsed.dataOffset, 44)
})

test('parseWav rejects non-WAV input', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file at all')))
})
