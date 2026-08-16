/**
 * Pure-Node synthesis of a short, loopable WAV test tone.
 * No ffmpeg or native modules required.
 *
 * The clip is a small two-bar "jingle": a soft kick thump on each bar and a
 * simple plucky arpeggio. Every note uses an envelope that ends at exactly
 * zero, so the loop point is click-free.
 */

const DEFAULT_SAMPLE_RATE = 44100
const DEFAULT_CHANNELS = 2

// [startSeconds, frequency, durationSeconds, gain]
function defaultNotes() {
  const bar = 2.0 // seconds per bar (120 BPM, 2 beats per bar)
  return [
    // Bar 1
    [0.00, 220.0, 0.28, 0.16], // A3
    [0.25, 261.63, 0.20, 0.14], // C4
    [0.50, 329.63, 0.30, 0.16], // E4
    [0.75, 392.0, 0.16, 0.12], // G4
    [1.00, 440.0, 0.24, 0.15], // A4
    [1.25, 392.0, 0.14, 0.11], // G4
    [1.50, 329.63, 0.34, 0.16], // E4
    // Bar 2 (a step lower)
    [bar + 0.00, 174.61, 0.28, 0.16], // F3
    [bar + 0.25, 220.0, 0.20, 0.14], // A3
    [bar + 0.50, 261.63, 0.30, 0.16], // C4
    [bar + 0.75, 293.66, 0.18, 0.13], // D4
    [bar + 1.00, 329.63, 0.32, 0.16], // E4
    [bar + 1.25, 261.63, 0.20, 0.13], // C4
    [bar + 1.50, 220.0, 0.40, 0.17], // A3 (ends 0.1s before the loop point)
  ]
}

function defaultKicks() {
  return [
    [0.0, 0.22, 0.30],
    [2.0, 0.22, 0.30],
  ]
}

/**
 * Synthesize a loopable WAV and return it as a Buffer (16-bit PCM, stereo).
 */
export function generateTestWav({
  seconds = 4,
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = DEFAULT_CHANNELS,
  notes = null,
  kicks = null,
} = {}) {
  const totalSamples = Math.round(seconds * sampleRate)
  notes ??= defaultNotes()
  kicks ??= defaultKicks()

  const mix = new Float64Array(totalSamples)

  const addTone = (start, freq, dur, gain) => {
    const attack = 0.008 // seconds
    const release = 0.03 // seconds — guarantees a zero crossing at the end
    const s0 = Math.max(0, Math.round(start * sampleRate))
    const s1 = Math.min(totalSamples, Math.round((start + dur) * sampleRate))
    const relFrom = Math.max(s0, Math.round((start + dur - release) * sampleRate))
    for (let s = s0; s < s1; s++) {
      const t = (s - s0) / sampleRate
      let env = Math.min(1, t / attack)
      if (s >= relFrom) env *= Math.max(0, 1 - (s - relFrom) / ((s1 - relFrom) || 1))
      const phase = 2 * Math.PI * freq * (s / sampleRate)
      // fundamental + a hint of 2nd harmonic for warmth
      const v = Math.sin(phase) + 0.35 * Math.sin(2 * phase)
      mix[s] += gain * env * v
    }
  }

  const addKick = (start, dur, gain) => {
    const s0 = Math.max(0, Math.round(start * sampleRate))
    const s1 = Math.min(totalSamples, Math.round((start + dur) * sampleRate))
    for (let s = s0; s < s1; s++) {
      const t = (s - s0) / sampleRate
      const env = Math.exp(-t * 24) // fast thumpy decay
      const phase = 2 * Math.PI * 55 * (s / sampleRate)
      mix[s] += gain * env * Math.sin(phase)
    }
  }

  for (const n of notes) addTone(n[0], n[1], n[2], n[3])
  for (const k of kicks) addKick(k[0], k[1], k[2])

  // Soft clip to keep peaks in range, then convert to int16.
  const dataBytes = totalSamples * channels * 2
  const pcm = Buffer.alloc(dataBytes)
  const frameBytes = channels * 2
  for (let s = 0; s < totalSamples; s++) {
    let v = Math.tanh(mix[s]) * 0.82 // gentle saturation + headroom
    const i16 = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
    for (let ch = 0; ch < channels; ch++) {
      const off = s * frameBytes + ch * 2
      pcm.writeInt16LE(i16, off)
    }
  }

  return buildWavBuffer({ pcm, sampleRate, channels, bits: 16 })
}

/**
 * Wrap raw 16-bit PCM into a standard RIFF/WAVE file Buffer.
 */
export function buildWavBuffer({ pcm, sampleRate, channels, bits = 16 }) {
  const byteRate = (sampleRate * channels * bits) / 8
  const blockAlign = (channels * bits) / 8
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

/**
 * Parse the fmt/data chunks of a WAV file so the file source knows where the
 * PCM samples start. Throws on unsupported formats.
 */
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let dataOffset = -1
  let dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        byteRate: buf.readUInt32LE(off + 16),
        blockAlign: buf.readUInt16LE(off + 20),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataOffset = off + 8
      dataSize = size
    }
    off += 8 + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk')
  if (dataOffset < 0) throw new Error('WAV has no data chunk')
  if (fmt.audioFormat !== 1) throw new Error('Only PCM (uncompressed) WAV files are supported')
  if (fmt.bits !== 16) throw new Error('Only 16-bit WAV files are supported')
  if (dataSize === 0 || dataSize > buf.length - dataOffset) {
    throw new Error('WAV data chunk is empty or truncated')
  }
  return { fmt, dataOffset, dataSize }
}
