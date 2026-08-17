/* Wi-Fi Audio Stream Client — Real-Time WebSocket Raw PCM Audio Engine */
'use strict'

const $ = (s) => document.querySelector(s)

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
}

/* ------------------------------------------------------------------ */
/* Application State                                                  */
/* ------------------------------------------------------------------ */
const state = {
  playing: false,
  ws: null,
  audioCtx: null,
  masterGain: null,
  channelSplitter: null,
  channelMerger: null,
  analyser: null,
  channelMode: 'stereo', // 'stereo' | 'left' | 'right'
  userVolume: 1,
  nextPlayTime: 0,
  pinEnabled: false,
  authed: true,
  animFrame: null,
}

function setStatus(statusText, isOnline = false) {
  els.statusText.textContent = statusText.toUpperCase()
  if (isOnline) {
    els.statusPill.className = 'status-badge online'
    els.joinBtn.classList.add('playing')
    els.joinLabel.textContent = 'DISCONNECT'
    els.playIcon.textContent = '■'
  } else {
    els.statusPill.className = 'status-badge offline'
    els.joinBtn.classList.remove('playing')
    els.joinLabel.textContent = 'CONNECT'
    els.playIcon.textContent = '▶'
  }
}

/* ------------------------------------------------------------------ */
/* Web Audio API Engine & Node Graph                                  */
/* ------------------------------------------------------------------ */
function initWebAudio() {
  if (state.audioCtx) return

  const AudioCtx = window.AudioContext || window.webkitAudioContext
  state.audioCtx = new AudioCtx({ latencyHint: 'interactive', sampleRate: 44100 })

  state.masterGain = state.audioCtx.createGain()
  state.masterGain.gain.value = state.userVolume

  state.analyser = state.audioCtx.createAnalyser()
  state.analyser.fftSize = 64
  state.analyser.smoothingTimeConstant = 0.8

  state.channelSplitter = state.audioCtx.createChannelSplitter(2)
  state.channelMerger = state.audioCtx.createChannelMerger(2)

  // Wiring: BufferSource -> ChannelSplitter -> ChannelMerger -> MasterGain -> Analyser -> Destination
  state.channelSplitter.connect(state.channelMerger, 0, 0)
  state.channelSplitter.connect(state.channelMerger, 1, 1)

  state.channelMerger.connect(state.masterGain)
  state.masterGain.connect(state.analyser)
  state.analyser.connect(state.audioCtx.destination)

  updateChannelRouting()
  startVisualizer()
}

function updateChannelRouting() {
  if (!state.audioCtx || !state.channelSplitter) return

  try {
    state.channelSplitter.disconnect()
  } catch { /* ignore */ }

  const s = state.channelSplitter
  const m = state.channelMerger

  if (state.channelMode === 'left') {
    s.connect(m, 0, 0)
    s.connect(m, 0, 1)
  } else if (state.channelMode === 'right') {
    s.connect(m, 1, 0)
    s.connect(m, 1, 1)
  } else {
    s.connect(m, 0, 0)
    s.connect(m, 1, 1)
  }
}

/* ------------------------------------------------------------------ */
/* Real-Time WebSocket Raw PCM Audio Stream Receiver                  */
/* ------------------------------------------------------------------ */
function connectWebSocket() {
  if (state.ws) {
    try { state.ws.close() } catch {}
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${location.host}/ws/audio`

  setStatus('CONNECTING...', false)
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  state.ws = ws

  ws.onopen = () => {
    state.playing = true
    setStatus('LIVE STREAM', true)
  }

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      schedulePcmChunk(event.data)
    }
  }

  ws.onerror = () => {
    startHttpFallback()
  }

  ws.onclose = () => {
    if (state.playing) {
      setStatus('RECONNECTING...', false)
      setTimeout(connectWebSocket, 1500)
    }
  }
}

function schedulePcmChunk(arrayBuffer) {
  if (!state.audioCtx) return

  const int16 = new Int16Array(arrayBuffer)
  if (int16.length < 2) return

  const samples = Math.floor(int16.length / 2) // 2 channels (stereo)
  const audioBuffer = state.audioCtx.createBuffer(2, samples, 44100)
  const left = audioBuffer.getChannelData(0)
  const right = audioBuffer.getChannelData(1)

  for (let i = 0; i < samples; i++) {
    left[i] = int16[i * 2] / 32768.0
    right[i] = int16[i * 2 + 1] / 32768.0
  }

  const now = state.audioCtx.currentTime
  if (state.nextPlayTime < now) {
    state.nextPlayTime = now + 0.05 // 50ms jitter buffer
  }

  const source = state.audioCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(state.channelSplitter)
  source.start(state.nextPlayTime)

  state.nextPlayTime += audioBuffer.duration
  state.playing = true
  setStatus('LIVE STREAM', true)
}

function startHttpFallback() {
  if (els.audioPlayer) {
    els.audioPlayer.src = `/stream?t=${Date.now()}`
    els.audioPlayer.volume = Math.min(1, state.userVolume)
    els.audioPlayer.play().then(() => {
      state.playing = true
      setStatus('LIVE STREAM', true)
    }).catch(() => {
      setStatus('READY', false)
    })
  }
}

async function startPlayback() {
  initWebAudio()
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume()
  }
  state.nextPlayTime = 0
  connectWebSocket()
}

function stopPlayback() {
  state.playing = false
  if (state.ws) {
    try { state.ws.close() } catch {}
    state.ws = null
  }
  if (els.audioPlayer) {
    els.audioPlayer.pause()
    els.audioPlayer.src = ''
  }
  setStatus('READY', false)
}

/* ------------------------------------------------------------------ */
/* Visualizer (Minimalist Black & White Spectrum)                      */
/* ------------------------------------------------------------------ */
function startVisualizer() {
  if (state.animFrame) cancelAnimationFrame(state.animFrame)

  const canvas = els.visualizer
  const ctx = canvas.getContext('2d')

  function draw() {
    state.animFrame = requestAnimationFrame(draw)
    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    if (!state.analyser || !state.playing) {
      ctx.beginPath()
      ctx.moveTo(0, height / 2)
      ctx.lineTo(width, height / 2)
      ctx.strokeStyle = '#222222'
      ctx.lineWidth = 1
      ctx.stroke()
      return
    }

    const bufferLength = state.analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    state.analyser.getByteFrequencyData(dataArray)

    const barWidth = (width / bufferLength) * 1.6
    let x = 0

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * (height * 0.85)

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(x, height - barHeight, barWidth - 3, barHeight)

      x += barWidth + 2
    }
  }

  draw()
}

/* ------------------------------------------------------------------ */
/* Event Listeners                                                    */
/* ------------------------------------------------------------------ */
els.joinBtn.addEventListener('click', () => {
  if (state.playing) {
    stopPlayback()
  } else {
    startPlayback()
  }
})

els.channelGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.grp-btn')
  if (!btn) return

  els.channelGroup.querySelectorAll('.grp-btn').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')

  state.channelMode = btn.dataset.channel
  updateChannelRouting()
})

els.volume.addEventListener('input', () => {
  const val = Number(els.volume.value)
  state.userVolume = val / 100
  els.volumeVal.textContent = `${val}%`
  
  if (state.masterGain) {
    state.masterGain.gain.value = state.userVolume
  }
  if (els.audioPlayer) {
    els.audioPlayer.volume = Math.min(1, state.userVolume)
  }
})

els.copyBtn.addEventListener('click', async () => {
  const url = els.urlBox.value
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    els.urlBox.select()
    document.execCommand('copy')
  }
  const original = els.copyBtn.textContent
  els.copyBtn.textContent = 'COPIED'
  setTimeout(() => { els.copyBtn.textContent = original }, 1500)
})

/* ------------------------------------------------------------------ */
/* Telemetry Polling                                                  */
/* ------------------------------------------------------------------ */
async function refreshStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' })
    const s = await r.json()

    els.urlBox.value = s.url
    els.clientCount.textContent = String(s.clients)
    els.streamMode.textContent = s.mode === 'static' ? 'TEST' : 'LIVE'

    els.securityNote.textContent = s.pinEnabled
      ? 'PIN PROTECTED STREAM'
      : 'SECURE LOCAL STREAM'

    if (s.pinEnabled && !s.authed) showPinGate()
  } catch {}
}

async function measureLatency() {
  const t0 = performance.now()
  try {
    await fetch('/api/time', { cache: 'no-store' })
    const rtt = Math.round(performance.now() - t0)
    els.latency.textContent = `${rtt}MS`
  } catch {
    els.latency.textContent = '—'
  }
}

/* PIN overlay */
function showPinGate() {
  els.pinOverlay.classList.remove('hidden')
  els.pinInput.focus()
}

els.pinForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  els.pinError.classList.add('hidden')
  const pin = els.pinInput.value.trim()
  if (!pin) return

  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    })
    if (r.ok) {
      els.pinOverlay.classList.add('hidden')
      els.pinInput.value = ''
      startPlayback()
    } else {
      els.pinError.textContent = 'INVALID PIN'
      els.pinError.classList.remove('hidden')
    }
  } catch {
    els.pinError.textContent = 'SERVER UNREACHABLE'
    els.pinError.classList.remove('hidden')
  }
})

/* Init */
async function init() {
  await refreshStatus()
  setInterval(refreshStatus, 4000)
  setInterval(measureLatency, 8000)
  measureLatency()
}

init()
