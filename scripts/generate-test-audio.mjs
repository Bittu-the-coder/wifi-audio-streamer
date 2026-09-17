/**
 * Generate the loopable test audio file:  pnpm gen:audio
 *
 * Options:
 *   node scripts/generate-test-audio.mjs [--out path] [--seconds n]
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateTestWav } from '../src/sources/wav-generator.js'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const secIdx = args.indexOf('--seconds')

const out = outIdx !== -1 ? args[outIdx + 1] : path.join('audio', 'test.wav')
const seconds = secIdx !== -1 ? Number(args[secIdx + 1]) : 4

if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('seconds must be a positive number')
  process.exit(1)
}

fs.mkdirSync(path.dirname(out), { recursive: true })
const buf = generateTestWav({ seconds })
fs.writeFileSync(out, buf)
console.log(`Wrote ${(buf.length / 1024).toFixed(0)} KB of loopable test audio to ${out} (${seconds}s, 44.1 kHz stereo 16-bit)`)
