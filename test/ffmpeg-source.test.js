import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFfmpegInputArgs,
  FfmpegSource,
} from '../src/sources/ffmpeg-source.js';

test('Windows auto capture uses WASAPI loopback for system audio', () => {
  const args = buildFfmpegInputArgs({ platform: 'win32', device: 'default' });
  assert.deepEqual(args, [
    '-f',
    'wasapi',
    '-audio_buffer_size',
    '100',
    '-loopback',
    '1',
    '-i',
    'default',
  ]);
});

test('Windows can explicitly capture a DirectShow device', () => {
  const args = buildFfmpegInputArgs({
    platform: 'win32',
    captureFormat: 'dshow',
    device: 'CABLE Output (VB-Audio Virtual Cable)',
  });
  assert.deepEqual(args, [
    '-f',
    'dshow',
    '-audio_buffer_size',
    '100',
    '-i',
    'audio=CABLE Output (VB-Audio Virtual Cable)',
  ]);
});

test('Ubuntu auto capture resolves the default output monitor through PulseAudio', () => {
  const args = buildFfmpegInputArgs({
    platform: 'linux',
    device: 'default',
    defaultSink: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
  });
  assert.deepEqual(args, [
    '-f',
    'pulse',
    '-fragment_size',
    '17640',
    '-i',
    'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor',
  ]);
});

test('Linux accepts an explicitly selected PulseAudio monitor', () => {
  const args = buildFfmpegInputArgs({
    platform: 'linux',
    captureFormat: 'pulse',
    device: 'alsa_output.usb-USB_Audio.monitor',
  });
  assert.deepEqual(args, [
    '-f',
    'pulse',
    '-fragment_size',
    '17640',
    '-i',
    'alsa_output.usb-USB_Audio.monitor',
  ]);
});

test('Ubuntu keeps a default sink name that is already a monitor source', () => {
  const args = buildFfmpegInputArgs({
    platform: 'linux',
    device: 'default',
    defaultSink: 'alsa_output.pci-0000_03_00.6.sink.monitor',
  });
  assert.equal(args.at(-1), 'alsa_output.pci-0000_03_00.6.sink.monitor');
});

test('FFmpeg applies configurable denoising together with volume', () => {
  const source = new FfmpegSource({
    platform: 'win32',
    device: 'default',
    volume: 0.8,
    noiseReduction: 18,
  });
  const args = source.buildArgs();
  const filterIndex = args.indexOf('-af');

  assert.notEqual(filterIndex, -1);
  assert.equal(args[filterIndex + 1], 'afftdn=nr=18:nf=-40:tn=1,volume=0.80');
});

test('noise reduction can be disabled without changing the PCM output format', () => {
  const source = new FfmpegSource({
    platform: 'win32',
    device: 'default',
    noiseReduction: 0,
  });
  const args = source.buildArgs();

  assert.equal(args.includes('-af'), false);
  assert.equal(args.at(-2), 's16le');
});
