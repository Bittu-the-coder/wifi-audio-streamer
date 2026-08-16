import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createApp } from '../src/server.js'
import { Broadcaster } from '../src/broadcaster.js'
import { Segmenter } from '../src/segmenter.js'
import { createAuth } from '../src/auth.js'

class FakeSource extends EventEmitter {
  constructor() {
    super()
    this.contentType = 'audio/mpeg'
    this.state = 'running'
    this.timer = null
  }
  start() {
    this.timer = setInterval(() => this.emit('data', Buffer.alloc(1024, 7)), 40)
    return this
  }
  stop() { if (this.timer) clearInterval(this.timer) }
  joinChunk() { return null }
  info() {
    return { type: 'fake', detail: 'fake-source', contentType: 'audio/mpeg', format: 'test stream' }
  }
}

const config = {
  mode: 'static',
  volume: 1,
  bufferTarget: 1.2,
  lanAddresses: ['127.0.0.1'],
  pin: '',
}

// Track everything that needs cleanup so the test process can exit.
const createdSources = []
const createdServers = []

function makeApp({ pin = '', mode = 'static' } = {}) {
  const source = new FakeSource()
  const broadcaster = new Broadcaster()
  source.on('data', (c) => broadcaster.push(c))
  source.start()
  createdSources.push(source)
  const app = createApp({
    config: { ...config, mode },
    source,
    broadcaster,
    auth: createAuth({ pin }),
    primaryUrl: 'http://127.0.0.1:8080',
    onVolumeChange: () => {},
  })
  return { app, source, broadcaster }
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  createdServers.push(server)
  await new Promise((r) => server.once('listening', r))
  return `http://127.0.0.1:${server.address().port}`
}

after(() => {
  for (const s of createdServers) s.close()
  for (const src of createdSources) src.stop()
})

let base = ''

before(async () => {
  const { app } = makeApp()
  base = await listen(app)
})

test('GET / serves the client page', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const html = await res.text()
  assert.match(html, /BT Speaker Engine|Wi-Fi Audio|WiFi Audio Stream/)
  assert.match(html, /CONNECT|Tap to Connect|Join stream/)
})

test('GET /api/status reports source, clients and URL', async () => {
  const res = await fetch(`${base}/api/status`)
  assert.equal(res.status, 200)
  const s = await res.json()
  assert.equal(s.ok, true)
  assert.equal(s.source.type, 'fake')
  assert.equal(typeof s.clients, 'number')
  assert.equal(s.url, 'http://127.0.0.1:8080')
  assert.equal(s.pinEnabled, false)
  assert.ok(s.serverTime > 0)
})

test('GET /api/time returns a server timestamp', async () => {
  const res = await fetch(`${base}/api/time`)
  assert.equal(res.status, 200)
  const { t } = await res.json()
  assert.ok(Math.abs(Date.now() - t) < 5000)
})

test('GET /api/qr returns an SVG QR code', async () => {
  const res = await fetch(`${base}/api/qr`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/)
  const body = await res.text()
  assert.match(body, /<svg/)
})

test('GET /stream streams audio with chunked encoding', async () => {
  const res = await fetch(`${base}/stream`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  const reader = res.body.getReader()
  const { value } = await reader.read()
  assert.ok(value && value.length > 0, 'expected audio bytes')
  await reader.cancel()
})

test('GET /stream increments the connected client count while open', async () => {
  const res = await fetch(`${base}/stream`)
  const reader = res.body.getReader()
  await reader.read()
  const status = await (await fetch(`${base}/api/status`)).json()
  assert.ok(status.clients >= 1, `expected >=1 client, got ${status.clients}`)
  await reader.cancel()
})

test('unknown routes return JSON 404', async () => {
  const res = await fetch(`${base}/nope`)
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error, 'Not found')
})

test('PIN-protected server blocks /stream until a valid PIN cookie', async () => {
  const { app } = makeApp({ pin: '1234' })
  const url = await listen(app)

  // Without a cookie -> 403
  const blocked = await fetch(`${url}/stream`)
  assert.equal(blocked.status, 403)

  // Wrong PIN -> 403
  const bad = await fetch(`${url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '0000' }),
  })
  assert.equal(bad.status, 403)

  // Correct PIN -> cookie
  const ok = await fetch(`${url}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' }),
  })
  assert.equal(ok.status, 200)
  const setCookie = ok.headers.get('set-cookie')
  assert.match(setCookie, /stream_auth=/)

  // With the cookie -> stream works
  const cookie = setCookie.split(';')[0]
  const allowed = await fetch(`${url}/stream`, { headers: { Cookie: cookie } })
  assert.equal(allowed.status, 200)
  await allowed.body.cancel()

  // Status reports authed state
  const st = await (await fetch(`${url}/api/status`, { headers: { Cookie: cookie } })).json()
  assert.equal(st.pinEnabled, true)
  assert.equal(st.authed, true)
  const st2 = await (await fetch(`${url}/api/status`)).json()
  assert.equal(st2.authed, false)
})

test('segment endpoints serve the manifest and segment bytes', async () => {
  const { app } = makeApp()
  const segmenter = new Segmenter({ segmentMs: 1000, keep: 4, bytesPerSecond: 16000 })
  for (let i = 0; i < 20; i++) segmenter.push(Buffer.alloc(8000)) // 160 KB -> 10s
  // Rebuild the app with the segmenter wired in
  const b = new Broadcaster()
  const s2 = new FakeSource()
  s2.on('data', (c) => b.push(c))
  s2.start()
  createdSources.push(s2)
  const app2 = createApp({
    config: { ...config, liveEdge: 1 },
    source: s2,
    broadcaster: b,
    auth: createAuth({}),
    primaryUrl: 'http://127.0.0.1:8080',
    onVolumeChange: () => {},
    segmenter,
  })
  const url = await listen(app2)

  const man = await (await fetch(`${url}/api/segments`)).json()
  assert.ok(man.liveId >= 9, `expected segments, got liveId ${man.liveId}`)
  assert.equal(man.edge, 1)
  assert.ok(man.segments.length >= 1)

  const res = await fetch(`${url}/segment/${man.liveId}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.ok(bytes.length > 0)

  const gone = await fetch(`${url}/segment/99999`)
  assert.equal(gone.status, 404)
})

test('POST /api/sync/start begins a new epoch and rewinds the stream', async () => {
  // Wire a segmenter that the fake source feeds (like index.js does)
  const segmenter = new Segmenter({ segmentMs: 200, keep: 8, bytesPerSecond: 16000 })
  const src = new FakeSource()
  let restarts = 0
  src.restart = () => { restarts++ }
  src.on('data', (c) => segmenter.push(c))
  src.start()
  createdSources.push(src)
  const b = new Broadcaster()
  const app2 = createApp({
    config: { ...config, syncLeadMs: 60 },
    source: src,
    broadcaster: b,
    auth: createAuth({}),
    primaryUrl: 'http://127.0.0.1:8080',
    onVolumeChange: () => {},
    segmenter,
  })
  const url = await listen(app2)

  // Let the first epoch produce some segments
  await new Promise((r) => setTimeout(r, 700))
  const before = await (await fetch(`${url}/api/segments`)).json()
  assert.ok(before.liveId >= 1, `expected segments before sync, got ${before.liveId}`)
  assert.equal(before.epoch, 0)

  // Trigger sync start
  const res = await fetch(`${url}/api/sync/start`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.epoch, 1)
  assert.ok(body.epochStartAt > Date.now())

  // After the lead time, the stream is rewound and the manifest shows epoch 1
  await new Promise((r) => setTimeout(r, 400))
  const after = await (await fetch(`${url}/api/segments`)).json()
  assert.equal(after.epoch, 1)
  assert.equal(restarts, 1, 'source.restart() must be called')
  assert.ok(after.liveId < before.liveId, `segment ids should rewind (${before.liveId} -> ${after.liveId})`)
})

test('POST /api/volume validates input and applies changes in ffmpeg mode', async () => {
  const { app } = makeApp({ mode: 'ffmpeg' })
  const url = await listen(app)

  const bad = await fetch(`${url}/api/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 99 }),
  })
  assert.equal(bad.status, 400)

  const ok = await fetch(`${url}/api/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 0.8 }),
  })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.volume, 0.8)
})
