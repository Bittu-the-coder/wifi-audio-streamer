/* Wi-Fi Audio Stream Client — Rock-Solid HTML5 Stream Engine with WebAudio Processing */
'use strict';

const $ = (s) => document.querySelector(s);

const els = {
  audioPlayer: $('#audioPlayer'),
  statusPill: $('#statusPill'),
  statusText: $('#statusText'),
  joinBtn: $('#joinBtn'),
  joinLabel: $('#joinLabel'),
  playIcon: $('#playIcon'),
  volume: $('#volume'),
  volumeVal: $('#volumeVal'),
  streamNote: $('#streamNote'),
  urlBox: $('#urlBox'),
  copyBtn: $('#copyBtn'),
  syncBtn: $('#syncBtn'),
  clientCount: $('#clientCount'),
  latency: $('#latency'),
  streamMode: $('#streamMode'),
  visualizer: $('#visualizer'),
  pinOverlay: $('#pinOverlay'),
  pinForm: $('#pinForm'),
  pinInput: $('#pinInput'),
  pinError: $('#pinError'),
  channelGroup: $('#channelGroup'),
  securityNote: $('#securityNote'),
};

/* ------------------------------------------------------------------ */
/* Application State                                                  */
/* ------------------------------------------------------------------ */
const state = {
  playing: false,
  audioCtx: null,
  sourceNode: null,
  masterGain: null,
  channelSplitter: null,
  channelMerger: null,
  analyser: null,
  channelMode: 'stereo', // 'stereo' | 'left' | 'right'
  userVolume: 1,
  pinEnabled: false,
  authed: true,
  animFrame: null,
  playbackMode: null,
  scheduledSources: new Set(),
  scheduledSegments: new Set(),
  segmentEpoch: null,
  epochStartAt: 0,
  serverOffsetMs: 0,
  segmentPoll: null,
  clockSync: null,
  pollingSegments: false,
  scheduledPlaybackAvailable: false,
  clientId:
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
};

function setStatus(statusText, isOnline = false) {
  els.statusText.textContent = statusText.toUpperCase();
  if (isOnline) {
    els.statusPill.className = 'status-badge online';
    els.joinBtn.classList.add('playing');
    els.joinLabel.textContent = 'DISCONNECT';
    els.playIcon.textContent = '■';
  } else {
    els.statusPill.className = 'status-badge offline';
    els.joinBtn.classList.remove('playing');
    els.joinLabel.textContent = 'CONNECT';
    els.playIcon.textContent = '▶';
  }
}

/* ------------------------------------------------------------------ */
/* Web Audio API Engine & Node Graph                                  */
/* ------------------------------------------------------------------ */
function initWebAudio() {
  if (state.audioCtx) return;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new AudioCtx({ latencyHint: 'interactive' });

  // Bridge HTML5 audio element into WebAudio graph
  try {
    state.sourceNode = state.audioCtx.createMediaElementSource(els.audioPlayer);
  } catch {
    /* Source node already created */
    return;
  }

  state.masterGain = state.audioCtx.createGain();
  state.masterGain.gain.value = state.userVolume;

  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 64;
  state.analyser.smoothingTimeConstant = 0.8;

  state.channelSplitter = state.audioCtx.createChannelSplitter(2);
  state.channelMerger = state.audioCtx.createChannelMerger(2);

  // Default wiring: Source -> Splitter -> Merger -> MasterGain -> Analyser -> Destination
  state.sourceNode.connect(state.channelSplitter);
  state.channelSplitter.connect(state.channelMerger, 0, 0);
  state.channelSplitter.connect(state.channelMerger, 1, 1);

  state.channelMerger.connect(state.masterGain);
  state.masterGain.connect(state.analyser);
  state.analyser.connect(state.audioCtx.destination);

  updateChannelRouting();
  startVisualizer();
}

function updateChannelRouting() {
  if (!state.audioCtx || !state.channelSplitter) return;

  try {
    state.channelSplitter.disconnect();
  } catch {
    /* ignore */
  }

  const s = state.channelSplitter;
  const m = state.channelMerger;

  if (state.channelMode === 'left') {
    // Route left input to both left and right speakers
    s.connect(m, 0, 0);
    s.connect(m, 0, 1);
  } else if (state.channelMode === 'right') {
    // Route right input to both left and right speakers
    s.connect(m, 1, 0);
    s.connect(m, 1, 1);
  } else {
    // Default stereo
    s.connect(m, 0, 0);
    s.connect(m, 1, 1);
  }
}

/* ------------------------------------------------------------------ */
/* Audio Stream Playback Controls                                     */
/* ------------------------------------------------------------------ */
async function startPlayback() {
  initWebAudio();
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume();
  }

  setStatus('CONNECTING...', false);

  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const status = response.ok ? await response.json() : null;
    if (
      status?.playbackMode === 'scheduled' &&
      status.scheduledPlayback &&
      state.audioCtx
    ) {
      state.playbackMode = 'scheduled';
      state.playing = true;
      state.segmentEpoch = null;
      state.scheduledSegments.clear();
      await syncServerClock();
      await scheduleAvailableSegments();
      state.segmentPoll = setInterval(
        scheduleAvailableSegments,
        Math.max(75, status.segmentMs)
      );
      state.clockSync = setInterval(syncServerClock, 10000);
      setStatus('LIVE SYNC', true);
      return;
    }
  } catch {
    // Fall back to the continuous stream if status cannot be read.
  }

  state.playbackMode = 'stream';
  const streamUrl = `/stream?t=${Date.now()}`;
  els.audioPlayer.src = streamUrl;
  els.audioPlayer.volume = 1;

  try {
    await els.audioPlayer.play();
    state.playing = true;
    setStatus('LIVE STREAM', true);
  } catch (err) {
    setStatus('READY', false);
    els.streamNote.textContent = `Autoplay blocked or stream unreachable. Tap CONNECT to retry.`;
    els.streamNote.classList.remove('hidden');
  }
}

function stopPlayback() {
  state.playing = false;
  state.playbackMode = null;
  clearInterval(state.segmentPoll);
  clearInterval(state.clockSync);
  state.segmentPoll = null;
  state.clockSync = null;
  stopScheduledSources();
  state.scheduledSegments.clear();
  els.audioPlayer.pause();
  els.audioPlayer.src = '';
  setStatus('READY', false);
}

function stopScheduledSources() {
  for (const source of state.scheduledSources) {
    try {
      source.stop();
    } catch {}
  }
  state.scheduledSources.clear();
}

async function syncServerClock() {
  const localStart = Date.now();
  try {
    const response = await fetch('/api/time', { cache: 'no-store' });
    if (!response.ok) return;
    const { t } = await response.json();
    const localEnd = Date.now();
    state.serverOffsetMs = t - (localStart + localEnd) / 2;
  } catch {}
}

async function scheduleAvailableSegments() {
  if (
    !state.playing ||
    state.playbackMode !== 'scheduled' ||
    state.pollingSegments
  )
    return;
  state.pollingSegments = true;
  try {
    const response = await fetch(
      `/api/segments?clientId=${encodeURIComponent(state.clientId)}`,
      {
        cache: 'no-store',
      }
    );
    if (!response.ok)
      throw new Error(`Segment manifest returned ${response.status}`);
    const manifest = await response.json();

    if (state.segmentEpoch !== manifest.epoch) {
      stopScheduledSources();
      state.scheduledSegments.clear();
      state.segmentEpoch = manifest.epoch;
      state.epochStartAt = manifest.epochStartAt;
    }

    const serverNow = Date.now() + state.serverOffsetMs;
    if (state.epochStartAt > serverNow) return;

    const retainedIds = new Set(manifest.segments.map((segment) => segment.id));
    for (const id of state.scheduledSegments) {
      if (!retainedIds.has(id)) state.scheduledSegments.delete(id);
    }

    for (const segment of manifest.segments) {
      if (state.scheduledSegments.has(segment.id)) continue;
      state.scheduledSegments.add(segment.id);
      if (segment.playAt <= serverNow + 35) continue;

      try {
        const audioResponse = await fetch(`/segment/${segment.id}`, {
          cache: 'no-store',
        });
        if (!audioResponse.ok)
          throw new Error(`Audio segment returned ${audioResponse.status}`);
        const audioBuffer = await state.audioCtx.decodeAudioData(
          await audioResponse.arrayBuffer()
        );
        if (!state.playing || state.segmentEpoch !== manifest.epoch) break;

        const latestServerNow = Date.now() + state.serverOffsetMs;
        const outputLatency =
          state.audioCtx.outputLatency ?? state.audioCtx.baseLatency ?? 0;
        const startAt =
          state.audioCtx.currentTime +
          (segment.playAt - latestServerNow) / 1000 -
          outputLatency;
        if (startAt < state.audioCtx.currentTime + 0.015) continue;

        const source = state.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(
          audioBuffer.numberOfChannels === 1
            ? state.masterGain
            : state.channelSplitter
        );
        state.scheduledSources.add(source);
        source.addEventListener(
          'ended',
          () => state.scheduledSources.delete(source),
          { once: true }
        );
        source.start(startAt);
      } catch (error) {
        state.scheduledSegments.delete(segment.id);
        els.streamNote.textContent = `Audio segment unavailable: ${error.message}`;
        els.streamNote.classList.remove('hidden');
      }
    }
  } catch (error) {
    if (state.playing) {
      els.streamNote.textContent = `Reconnecting to synchronized audio: ${error.message}`;
      els.streamNote.classList.remove('hidden');
    }
  } finally {
    state.pollingSegments = false;
  }
}

/* Gently recover live-edge drift without seeking through the audio. */
setInterval(() => {
  if (!state.playing || !els.audioPlayer || els.audioPlayer.paused) return;
  const buf = els.audioPlayer.buffered;
  if (buf && buf.length > 0) {
    const liveEnd = buf.end(buf.length - 1);
    const lag = liveEnd - els.audioPlayer.currentTime;
    if (lag > 0.15) {
      els.audioPlayer.playbackRate = 1.04;
    } else {
      els.audioPlayer.playbackRate = 1.0;
    }
  }
}, 400);

/* ------------------------------------------------------------------ */
/* Visualizer (Minimalist Black & White Spectrum)                      */
/* ------------------------------------------------------------------ */
function startVisualizer() {
  if (state.animFrame) cancelAnimationFrame(state.animFrame);

  const canvas = els.visualizer;
  const ctx = canvas.getContext('2d');

  function draw() {
    state.animFrame = requestAnimationFrame(draw);
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (!state.analyser || !state.playing) {
      // Idle thin center line
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    state.analyser.getByteFrequencyData(dataArray);

    const barWidth = (width / bufferLength) * 1.6;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * (height * 0.85);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, height - barHeight, barWidth - 3, barHeight);

      x += barWidth + 2;
    }
  }

  draw();
}

/* ------------------------------------------------------------------ */
/* Event Listeners                                                    */
/* ------------------------------------------------------------------ */
els.joinBtn.addEventListener('click', () => {
  if (state.playing) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

els.channelGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.grp-btn');
  if (!btn) return;

  els.channelGroup
    .querySelectorAll('.grp-btn')
    .forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  state.channelMode = btn.dataset.channel;
  updateChannelRouting();
});

els.volume.addEventListener('input', () => {
  const val = Number(els.volume.value);
  state.userVolume = val / 100;
  els.volumeVal.textContent = `${val}%`;

  els.audioPlayer.volume = state.masterGain ? 1 : Math.min(1, state.userVolume);
  if (state.masterGain) {
    state.masterGain.gain.value = state.userVolume;
  }
});

els.syncBtn.addEventListener('click', async () => {
  els.syncBtn.disabled = true;
  try {
    const response = await fetch('/api/sync/start', { method: 'POST' });
    if (!response.ok)
      throw new Error(`Sync request returned ${response.status}`);
    els.streamNote.textContent = 'All connected devices will restart together.';
    els.streamNote.classList.remove('hidden');
  } catch (error) {
    els.streamNote.textContent = `Could not sync devices: ${error.message}`;
    els.streamNote.classList.remove('hidden');
  } finally {
    els.syncBtn.disabled = !state.scheduledPlaybackAvailable;
  }
});

els.copyBtn.addEventListener('click', async () => {
  const url = els.urlBox.value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    els.urlBox.select();
    document.execCommand('copy');
  }
  const original = els.copyBtn.textContent;
  els.copyBtn.textContent = 'COPIED';
  setTimeout(() => {
    els.copyBtn.textContent = original;
  }, 1500);
});

els.audioPlayer.addEventListener('error', () => {
  if (state.playing) {
    setStatus('RECONNECTING...', false);
    setTimeout(startPlayback, 2000);
  }
});

/* ------------------------------------------------------------------ */
/* Telemetry Polling                                                  */
/* ------------------------------------------------------------------ */
async function refreshStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const s = await r.json();

    els.urlBox.value = s.url;
    els.clientCount.textContent = String(s.clients);
    els.streamMode.textContent = s.mode === 'static' ? 'TEST' : 'LIVE';
    state.scheduledPlaybackAvailable =
      s.playbackMode === 'scheduled' && s.scheduledPlayback;
    els.syncBtn.disabled = !state.scheduledPlaybackAvailable;

    els.securityNote.textContent = s.pinEnabled
      ? 'PIN PROTECTED STREAM'
      : 'SECURE LOCAL STREAM';

    if (s.pinEnabled && !s.authed) showPinGate();
  } catch {}
}

async function measureLatency() {
  const startedAt = performance.now();
  try {
    const response = await fetch('/api/time', { cache: 'no-store' });
    if (!response.ok)
      throw new Error(`Time request returned ${response.status}`);
    els.latency.textContent = `${Math.round(performance.now() - startedAt)}MS`;
  } catch {
    els.latency.textContent = '—';
  }
}

/* PIN overlay */
function showPinGate() {
  els.pinOverlay.classList.remove('hidden');
  els.pinInput.focus();
}

els.pinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.pinError.classList.add('hidden');
  const pin = els.pinInput.value.trim();
  if (!pin) return;

  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (r.ok) {
      els.pinOverlay.classList.add('hidden');
      els.pinInput.value = '';
      startPlayback();
    } else {
      els.pinError.textContent = 'INVALID PIN';
      els.pinError.classList.remove('hidden');
    }
  } catch {
    els.pinError.textContent = 'SERVER UNREACHABLE';
    els.pinError.classList.remove('hidden');
  }
});

/* Init */
async function init() {
  await refreshStatus();
  await measureLatency();
  setInterval(refreshStatus, 4000);
  setInterval(measureLatency, 5000);
}

init();
