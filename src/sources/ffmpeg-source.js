import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { buildWavHeader } from './wav-generator.js';

export function buildFfmpegInputArgs({
  platform = process.platform,
  captureFormat = 'auto',
  device = 'default',
  defaultSink = null,
  bufferMs = 100,
} = {}) {
  const format =
    captureFormat === 'auto'
      ? platform === 'win32'
        ? device === 'default' || device.toLowerCase().startsWith('wasapi')
          ? 'wasapi'
          : 'dshow'
        : platform === 'linux'
          ? 'pulse'
          : null
      : captureFormat;

  if (platform === 'win32' && format === 'wasapi') {
    const wasapiDevice = device.toLowerCase().startsWith('wasapi:')
      ? device.slice(7)
      : device;
    return [
      '-f',
      'wasapi',
      ...(bufferMs > 0 ? ['-audio_buffer_size', String(bufferMs)] : []),
      '-loopback',
      '1',
      '-i',
      wasapiDevice === 'wasapi' ? 'default' : wasapiDevice,
    ];
  }
  if (platform === 'win32' && format === 'dshow') {
    return [
      '-f',
      'dshow',
      ...(bufferMs > 0 ? ['-audio_buffer_size', String(bufferMs)] : []),
      '-i',
      `audio=${device}`,
    ];
  }
  if (platform === 'linux' && (format === 'pulse' || format === 'alsa')) {
    let inputDevice = device;
    if (
      format === 'pulse' &&
      (device === 'default' || device === 'default.monitor') &&
      defaultSink
    ) {
      inputDevice = defaultSink.endsWith('.monitor')
        ? defaultSink
        : `${defaultSink}.monitor`;
    }
    const fragmentSize = Math.max(1, Math.round((176400 * bufferMs) / 1000));
    return [
      '-f',
      format,
      ...(format === 'pulse' && bufferMs > 0
        ? ['-fragment_size', String(fragmentSize)]
        : []),
      '-i',
      inputDevice,
    ];
  }

  throw new Error(
    `Capture format "${format ?? captureFormat}" is not supported on ${platform}`
  );
}

function getDefaultPulseSink() {
  try {
    const result = spawnSync('pactl', ['get-default-sink'], {
      encoding: 'utf8',
      timeout: 1500,
    });
    if (result.status === 0) return result.stdout.trim() || null;
  } catch {}
  return null;
}

/**
 * Live capture source: runs ffmpeg as a child process, capturing the system
 * audio device via WASAPI, DirectShow, PulseAudio, or ALSA and emits PCM on
 * stdout.
 *
 * The owner (index.js) is responsible for restart / fallback policies — this
 * class just spawns, streams, and reports what happened.
 */

export class FfmpegSource extends EventEmitter {
  constructor({
    ffmpegPath = 'ffmpeg',
    device = 'default',
    captureFormat = 'auto', // 'auto' | 'wasapi' | 'dshow' | 'pulse' | 'alsa'
    platform = process.platform,
    bufferMs = 40,
    noiseReduction = 18,
    volume = 1,
    extraArgs = [],
  } = {}) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.device = device;
    this.captureFormat = captureFormat;
    this.platform = platform;
    this.bufferMs = bufferMs;
    this.noiseReduction = Number.isFinite(Number(noiseReduction))
      ? Math.max(0, Math.min(30, Number(noiseReduction)))
      : 18;
    this.volume = volume;
    this.extraArgs = extraArgs;
    this.stopped = false;
    this.state = 'idle';
    this.proc = null;
    this.stderrTail = '';
    this.startedAt = 0;
    this.contentType = 'audio/wav';
    this.format = 'PCM signed 16-bit little-endian, 44100 Hz, stereo';
    this.bytesPerSecond = 44100 * 2 * 2;
    this.wavFormat = { sampleRate: 44100, channels: 2, bits: 16 };
    this.headerChunk = buildWavHeader({
      ...this.wavFormat,
      dataSize: 0xffffffff,
    });
  }

  joinChunk() {
    return Buffer.from(this.headerChunk);
  }

  buildArgs() {
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-fflags',
      '+nobuffer+fastseek',
      '-flags',
      '+low_delay',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
    ];

    args.push(
      ...buildFfmpegInputArgs({
        platform: this.platform,
        captureFormat: this.captureFormat,
        device: this.device,
        defaultSink: this.platform === 'linux' ? getDefaultPulseSink() : null,
        bufferMs: this.bufferMs,
      })
    );

    // User-supplied escape hatch (input options, filters, device overrides…)
    if (this.extraArgs.length) args.push(...this.extraArgs);

    args.push(
      '-c:a',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-flush_packets',
      '1'
    );
    const audioFilters = [];
    if (this.noiseReduction > 0)
      audioFilters.push(`afftdn=nr=${this.noiseReduction}:nf=-40:tn=1`);
    if (this.volume !== 1)
      audioFilters.push(`volume=${this.volume.toFixed(2)}`);
    if (audioFilters.length) args.push('-af', audioFilters.join(','));
    args.push('-f', 's16le', 'pipe:1');
    return args;
  }

  start() {
    if (this.stopped) return;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.stderrTail = '';
    this.sawData = false;

    let proc;
    try {
      proc = spawn(this.ffmpegPath, this.buildArgs(), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.state = 'error';
      this.emit('error', {
        message: `Could not start ffmpeg: ${err.message}`,
        stderr: '',
      });
      return;
    }
    this.proc = proc;

    proc.stdout.on('data', (chunk) => {
      if (!this.sawData) {
        this.sawData = true;
        this.state = 'running';
        this.emit('first-data');
      }
      this.emit('data', chunk);
    });

    const tail = (s) => {
      this.stderrTail = (this.stderrTail + s).slice(-4096);
    };
    proc.stderr.on('data', (d) => tail(d.toString('utf8')));
    proc.on('error', (err) => {
      if (this.stopped) return;
      this.state = 'error';
      this.emit('error', { message: err.message, stderr: this.stderrTail });
    });
    proc.on('exit', (code, signal) => {
      if (this.stopped) return;
      this.state = 'stopped';
      this.emit('exit', {
        code,
        signal,
        stderr: this.stderrTail,
        sawData: this.sawData,
      });
    });
  }

  /** Restart with a new output volume (kills the current process). */
  setVolume(volume) {
    this.volume = Math.max(0.05, Math.min(2, volume));
    this.stop();
    this.stopped = false; // allow restart
    this.start();
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    this.state = 'stopped';
  }

  info() {
    return {
      type: 'ffmpeg',
      detail: this.device,
      device: this.device,
      captureFormat: this.captureFormat,
      noiseReduction: this.noiseReduction,
      volume: this.volume,
      ffmpegPath: this.ffmpegPath,
      contentType: this.contentType,
      format: this.format,
      bytesPerSecond: this.bytesPerSecond,
      wavFormat: this.wavFormat,
      state: this.state,
      stderrTail: this.stderrTail.slice(-512),
    };
  }
}

/** Quick check that the ffmpeg binary exists and runs. */
export function ffmpegAvailable(ffmpegPath = 'ffmpeg') {
  try {
    const r = spawnSync(ffmpegPath, ['-version'], {
      windowsHide: true,
      timeout: 8000,
    });
    return r.status === 0 && r.stdout?.length > 0;
  } catch {
    return false;
  }
}
