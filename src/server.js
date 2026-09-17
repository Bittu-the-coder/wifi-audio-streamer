import express from 'express'
import path from 'node:path'
import { PUBLIC_DIR } from './config.js'
import { parseCookies, COOKIE_NAME } from './auth.js'

/**
 * Build the Express app. Everything is injected so tests can run a server
 * against a fake source.
 */
export function createApp({ config, source, broadcaster, auth, primaryUrl, onVolumeChange = null, segmenter = null }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })

  // The page itself is never cached so phones always get the latest UI;
  // static assets (css/js) get a short cache.
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(staticIndexPath())
  })
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 })) // ETag revalidation keeps clients fresh

  // ---- The audio stream -------------------------------------------------
  const requireAuth = (req, res, next) => {
    if (!auth.enabled) return next()
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME]
    if (auth.verify(token)) return next()
    return res.status(403).json({ error: 'PIN required', code: 'AUTH_REQUIRED' })
  }

  app.get('/stream', requireAuth, (req, res) => {
    if (!source) return res.status(503).json({ error: 'Audio source not ready' })
    if (req.method === 'HEAD') {
      res.set('Content-Type', source.info().contentType)
      res.end()
      return
    }
    const initial = typeof source.joinChunk === 'function' ? source.joinChunk() : null
    broadcaster.addClient(res, { contentType: source.info().contentType, initialChunk: initial })
  })

  // ---- Live-edge segments (sync protocol) -----------------------------
  const sync = { epoch: 0, epochStartAt: 0 }
  let syncTimer = null

  app.get('/api/segments', requireAuth, (req, res) => {
    if (!segmenter) return res.status(503).json({ error: 'Segments not available' })
    res.json({
      ...segmenter.manifest(),
      edge: config.liveEdge ?? 1,
      epoch: sync.epoch,
      epochStartAt: sync.epochStartAt,
    })
  })

  /**
   * Host-triggered "Sync start": begin a new epoch. The stream rewinds to
   * position 0 (static mode) / starts fresh (live mode) at `epochStartAt`,
   * and all phones start playing segment 0 at that same moment.
   */
  app.post('/api/sync/start', requireAuth, (req, res) => {
    if (!source || !segmenter) return res.status(503).json({ error: 'Audio source not ready' })
    const leadMs = config.syncLeadMs ?? 2500
    sync.epochStartAt = Date.now() + leadMs
    sync.epoch += 1
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      if (typeof source.restart === 'function') source.restart()
      segmenter.reset()
      console.log(`[wifi-audio] sync epoch ${sync.epoch} started (${new Date().toISOString()})`)
    }, leadMs)
    res.json({ ok: true, epoch: sync.epoch, epochStartAt: sync.epochStartAt, leadMs })
  })

  app.get('/segment/:id', requireAuth, (req, res) => {
    if (!segmenter) return res.status(503).json({ error: 'Segments not available' })
    const buf = segmenter.get(req.params.id)
    if (!buf) return res.status(404).json({ error: 'Segment expired — rejoin at the live edge' })
    res.set('Content-Type', segmenter.contentType)
    res.set('Content-Length', String(buf.length))
    res.set('Cache-Control', 'public, max-age=3600')
    res.send(buf)
  })

  // ---- Status / utility APIs --------------------------------------------
  const startedAt = Date.now()

  app.get('/api/status', (req, res) => {
    const s = source ? source.info() : null
    res.json({
      ok: true,
      startedAt,
      serverTime: Date.now(),
      mode: config.mode,
      source: s,
      clients: broadcaster.count,
      totalBytes: broadcaster.totalBytes,
      url: primaryUrl,
      lanAddresses: config.lanAddresses ?? [],
      pinEnabled: auth.enabled,
      authed: auth.enabled ? auth.verify(parseCookies(req.headers.cookie || '')[COOKIE_NAME]) : true,
      bufferTarget: config.bufferTarget,
      note: config.note ?? null,
      epoch: sync.epoch,
      epochStartAt: sync.epochStartAt,
      volume: config.volume,
      volumeSupported: config.mode === 'ffmpeg',
      uptime: Math.round((Date.now() - startedAt) / 1000),
    })
  })

  app.get('/api/time', (req, res) => {
    res.json({ t: Date.now() })
  })

  app.post('/api/auth', (req, res) => {
    if (!auth.enabled) return res.status(400).json({ error: 'No PIN configured' })
    const { pin } = req.body ?? {}
    if (!auth.checkPin(pin)) {
      return res.status(403).json({ error: 'Wrong PIN' })
    }
    res.set(
      'Set-Cookie',
      `${COOKIE_NAME}=${auth.issue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
    )
    res.json({ ok: true })
  })

  app.post('/api/volume', (req, res) => {
    if (config.mode !== 'ffmpeg' || !source) {
      return res.status(400).json({ error: 'Server-side volume is only available in ffmpeg (live capture) mode' })
    }
    const { volume } = req.body ?? {}
    const v = Number.parseFloat(volume)
    if (!Number.isFinite(v) || v < 0.05 || v > 2) {
      return res.status(400).json({ error: 'volume must be a number between 0.05 and 2' })
    }
    config.volume = v
    if (onVolumeChange) onVolumeChange(v)
    res.json({ ok: true, volume: v })
  })

  app.get('/api/qr', async (req, res) => {
    try {
      const { default: QRCode } = await import('qrcode')
      const svg = await QRCode.toString(primaryUrl, {
        type: 'svg',
        margin: 1,
        width: 640,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' },
      })
      res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg)
    } catch (err) {
      res.status(500).json({ error: `QR generation failed: ${err.message}` })
    }
  })

  // ---- Fallbacks ---------------------------------------------------------
  app.use((req, res) => res.status(404).json({ error: 'Not found' }))

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}

export function staticIndexPath() {
  return path.join(PUBLIC_DIR, 'index.html')
}
