import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * Live capture source: runs ffmpeg as a child process, capturing the system
 * audio device (VB-Audio Virtual Cable's "CABLE Output", or "Stereo Mix", …)
 * via DirectShow and encoding to MP3 on stdout.
 *
 * The owner (index.js) is responsible for restart / fallback policies — this
 * class just spawns, streams, and reports what happened.
 */

export class FfmpegSource extends EventEmitter {
  constructor({
    ffmpegPath = 'ffmpeg',
    device = 'default',
    captureFormat = 'auto', // 'auto' | 'wasapi' | 'dshow'
    audioCodec = 'pcm', // 'pcm' | 'mp3'
    bitrate = '128k',
    bufferMs = 20,
    sampleRate = 48000,
    channels = 2,
    frameMs = 10,
    volume = 1,
    extraArgs = [],
  } = {}) {
    super()
    this.ffmpegPath = ffmpegPath
    this.device = device
    this.captureFormat = captureFormat
    this.audioCodec = audioCodec
    this.bitrate = bitrate
    this.bufferMs = bufferMs
    this.sampleRate = sampleRate
    this.channels = channels
    this.frameMs = frameMs
    this.frameBytes = Math.max(2 * channels, Math.floor(sampleRate * channels * 2 * frameMs / 1000 / (channels * 2)) * channels * 2)
    this.remainder = Buffer.alloc(0)
    this.volume = volume
    this.extraArgs = extraArgs
    this.stopped = false
    this.state = 'idle'
    this.proc = null
    this.stderrTail = ''
    this.startedAt = 0
    this.contentType = audioCodec === 'pcm' ? 'audio/pcm' : 'audio/mpeg'
    this.format = null
  }

  buildArgs() {
    const isWasapi =
      this.captureFormat === 'wasapi' ||
      (this.captureFormat === 'auto' &&
        (this.device === 'default' || this.device.toLowerCase().startsWith('wasapi')))

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', '+nobuffer',
      '-flags', '+low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
    ]

    if (isWasapi) {
      args.push('-f', 'wasapi')
      if (this.bufferMs > 0) args.push('-audio_buffer_size', String(this.bufferMs))
      args.push('-i', this.device === 'wasapi' ? 'default' : this.device)
    } else {
      args.push('-f', 'dshow')
      if (this.bufferMs > 0) args.push('-audio_buffer_size', String(this.bufferMs))
      args.push('-i', `audio=${this.device}`)
    }

    if (this.extraArgs.length) args.push(...this.extraArgs)

    if (this.audioCodec === 'pcm') {
      args.push(
        '-c:a', 'pcm_s16le',
        '-ar', String(this.sampleRate),
        '-ac', String(this.channels),
      )
      if (this.volume !== 1) {
        args.push('-af', `volume=${this.volume.toFixed(2)}`)
      }
      args.push('-f', 's16le', 'pipe:1')
    } else {
      args.push(
        '-c:a', 'libmp3lame',
        '-b:a', this.bitrate,
        '-ar', String(this.sampleRate),
        '-ac', String(this.channels),
        '-write_xing', '0',
        '-flush_packets', '1',
      )
      if (this.volume !== 1) {
        args.push('-af', `volume=${this.volume.toFixed(2)}`)
      }
      args.push('-f', 'mp3', 'pipe:1')
    }
    return args
  }

  start() {
    if (this.stopped) return
    this.state = 'starting'
    this.startedAt = Date.now()
    this.stderrTail = ''
    this.sawData = false
    this.remainder = Buffer.alloc(0)

    let proc
    try {
      proc = spawn(this.ffmpegPath, this.buildArgs(), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      this.state = 'error'
      this.emit('error', { message: `Could not start ffmpeg: ${err.message}`, stderr: '' })
      return
    }
    this.proc = proc

    proc.stdout.on('data', (chunk) => {
      if (!this.sawData) {
        this.sawData = true
        this.state = 'running'
        this.emit('first-data')
      }
      // stdout chunk boundaries are arbitrary; emit fixed, whole PCM frames.
      const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk
      const usable = data.length - (data.length % this.frameBytes)
      for (let offset = 0; offset < usable; offset += this.frameBytes) {
        this.emit('data', data.subarray(offset, offset + this.frameBytes))
      }
      this.remainder = usable === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(usable))
    })

    const tail = (s) => {
      this.stderrTail = (this.stderrTail + s).slice(-4096)
    }
    proc.stderr.on('data', (d) => tail(d.toString('utf8')))
    proc.on('error', (err) => {
      if (this.stopped) return
      this.state = 'error'
      this.emit('error', { message: err.message, stderr: this.stderrTail })
    })
    proc.on('exit', (code, signal) => {
      if (this.stopped) return
      this.state = 'stopped'
      this.emit('exit', { code, signal, stderr: this.stderrTail, sawData: this.sawData })
    })
  }

  /** Restart with a new output volume (kills the current process). */
  setVolume(volume) {
    this.volume = Math.max(0.05, Math.min(2, volume))
    this.stop()
    this.stopped = false // allow restart
    this.start()
  }

  stop() {
    this.stopped = true
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.proc = null
    }
    this.state = 'stopped'
  }

  info() {
    return {
      type: 'ffmpeg',
      detail: this.device,
      device: this.device,
      bitrate: this.bitrate,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: 16,
      frameMs: this.frameMs,
      volume: this.volume,
      ffmpegPath: this.ffmpegPath,
      contentType: this.contentType,
      state: this.state,
      stderrTail: this.stderrTail.slice(-512),
    }
  }
}

/** Quick check that the ffmpeg binary exists and runs. */
export function ffmpegAvailable(ffmpegPath = 'ffmpeg') {
  try {
    const r = spawnSync(ffmpegPath, ['-version'], { windowsHide: true, timeout: 8000 })
    return r.status === 0 && r.stdout?.length > 0
  } catch {
    return false
  }
}
