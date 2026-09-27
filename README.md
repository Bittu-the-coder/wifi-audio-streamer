# Wi-Fi Audio Streamer

Stream a computer's system audio to phones on the same Wi-Fi network. Phones use a browser; no companion app is required. Windows and Ubuntu are supported as the audio-capture host.

## Requirements

- Node.js 20.11 or newer
- FFmpeg available on `PATH`
- Windows 10/11 with WASAPI, or Ubuntu with PipeWire/PulseAudio and `pactl`
- Phones and host on the same local network

## Install

Windows PowerShell:

```powershell
winget install Gyan.FFmpeg
corepack enable
pnpm install
pnpm check:setup
pnpm start
```

Ubuntu:

```bash
sudo apt update
sudo apt install ffmpeg pulseaudio-utils
corepack enable
pnpm install
pnpm check:setup
pnpm start
```

The server prints a local URL and QR code. Open it on each phone, tap **CONNECT**, then tap **SYNC DEVICES** to align playback. Browser audio starts only after a user gesture.

## Audio Capture

`MODE=auto` uses live system-audio capture when FFmpeg is available; otherwise it plays a generated test tone. On Windows, the default uses WASAPI loopback from the current output device. On Ubuntu, the default uses the monitor source for the active PulseAudio/PipeWire output sink.

To inspect audio sources:

```bash
pnpm list:devices
```

Set `CAPTURE_DEVICE` to a specific monitor/source when automatic selection is not right. On Windows, select DirectShow explicitly with `CAPTURE_FORMAT=dshow`. The setup doctor reports missing dependencies and audio sources:

```bash
pnpm check:setup
```

## Latency and Sync

Audio is sent as uncompressed 16-bit PCM in short WAV segments. The default segment is 100 ms with a 400 ms playout cushion; this keeps phones on a shared playback clock while absorbing ordinary Wi-Fi jitter. Actual speaker delay also depends on the phone, browser, Wi-Fi quality, and any Bluetooth output connected to the phone. There is no zero-latency guarantee.

Live capture applies adaptive FFmpeg noise reduction at a moderate default strength (`NOISE_REDUCTION=18`). Set it between `0` and `30`; use `0` to disable it or a lower value if speech sounds over-processed. Noise reduction cannot remove distortion or noise already baked into a recording.

Increase `PLAYOUT_DELAY_MS` if playback stutters on a busy or weak network. Decrease it in small steps if the network is stable and lower delay matters more. Several phones can play together, but independent device clocks and speaker hardware prevent sample-perfect synchronization.

## Configuration

Copy `.env.example` to `.env`. Keep comments on their own lines; the simple `.env` reader does not support inline comments.

| Setting            | Default   | Purpose                                       |
| ------------------ | --------- | --------------------------------------------- |
| `MODE`             | `auto`    | `auto`, `ffmpeg`, or `static`                 |
| `FFMPEG_PATH`      | `ffmpeg`  | FFmpeg executable or full path                |
| `CAPTURE_FORMAT`   | `auto`    | `auto`, `wasapi`, `dshow`, `pulse`, or `alsa` |
| `CAPTURE_DEVICE`   | `default` | System output or an explicit capture source   |
| `AUDIO_BUFFER_MS`  | `40`      | Capture input buffer target                   |
| `NOISE_REDUCTION`  | `18`      | Adaptive noise reduction (`0` disables)       |
| `SEGMENT_MS`       | `100`     | PCM segment duration                          |
| `PLAYOUT_DELAY_MS` | `400`     | Shared scheduled-playback cushion             |
| `SYNC_LEAD_MS`     | `2500`    | Countdown before a shared sync restart        |
| `PORT`             | `8080`    | Web server port                               |
| `HOST`             | `0.0.0.0` | Bind address                                  |
| `LAN_IP`           | automatic | Override the address shown to phones          |
| `AUTH_PIN`         | empty     | Optional shared PIN for the stream            |

Allow the selected port through the host firewall on private networks. For Ubuntu with UFW, for example: `sudo ufw allow 8080/tcp`. On Windows, allow Node.js on private networks when prompted.

## Tests

```bash
pnpm test
```
