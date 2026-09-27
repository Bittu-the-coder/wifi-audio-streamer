import express from 'express';
import path from 'node:path';
import { COOKIE_NAME, parseCookies } from './auth.js';
import { PUBLIC_DIR } from './config.js';

/** Build the Express app. Dependencies are injected so tests can use fake sources. */
export function createApp({
  config,
  source,
  broadcaster,
  auth,
  primaryUrl,
  onVolumeChange = null,
  segmenter = null,
  getSource = null,
  getSegmenter = null,
}) {
  const app = express();
  const sync = { epoch: 0, epochStartAt: 0 };
  const scheduledClients = new Map();
  const activeScheduledClientCount = () => {
    const cutoff = Date.now() - 15000;
    for (const [id, lastSeen] of scheduledClients) {
      if (lastSeen < cutoff) scheduledClients.delete(id);
    }
    return scheduledClients.size;
  };
  let segmentBytesTransferred = 0;
  let observedSegmenter = getSegmenter?.() ?? segmenter;
  const activeSource = () => getSource?.() ?? source;
  const activeSegmenter = () => {
    const current = getSegmenter?.() ?? segmenter;
    if (current !== observedSegmenter) {
      observedSegmenter = current;
      sync.epoch += 1;
      sync.epochStartAt = 0;
    }
    return current;
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const getRuntimeStats = () => ({
    clients: broadcaster.count + activeScheduledClientCount(),
    transferredBytes: broadcaster.bytesDelivered + segmentBytesTransferred,
  });
  app.locals.getRuntimeStats = getRuntimeStats;
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(staticIndexPath());
  });
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

  const requireAuth = (req, res, next) => {
    if (!auth.enabled) return next();
    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (auth.verify(token)) return next();
    return res
      .status(403)
      .json({ error: 'PIN required', code: 'AUTH_REQUIRED' });
  };

  app.get('/stream', requireAuth, (req, res) => {
    const source = activeSource();
    if (!source)
      return res.status(503).json({ error: 'Audio source not ready' });
    if (req.method === 'HEAD') {
      res.set('Content-Type', source.info().contentType);
      res.end();
      return;
    }
    const initialChunk =
      typeof source.joinChunk === 'function' ? source.joinChunk() : null;
    broadcaster.addClient(res, {
      contentType: source.info().contentType,
      initialChunk,
    });
  });

  let syncTimer = null;
  app.get('/api/segments', requireAuth, (req, res) => {
    const segmenter = activeSegmenter();
    if (!segmenter)
      return res.status(503).json({ error: 'Segments not available' });
    const clientId = req.query.clientId;
    if (
      typeof clientId === 'string' &&
      /^[A-Za-z0-9_-]{8,64}$/.test(clientId)
    ) {
      if (scheduledClients.has(clientId) || scheduledClients.size < 256) {
        scheduledClients.set(clientId, Date.now());
      }
    }
    res.json({
      ...segmenter.manifest(),
      serverTime: Date.now(),
      edge: config.liveEdge ?? 1,
      epoch: sync.epoch,
      epochStartAt: sync.epochStartAt,
    });
  });

  app.post('/api/sync/start', requireAuth, (req, res) => {
    if (!activeSource() || !activeSegmenter()) {
      return res.status(503).json({ error: 'Audio source not ready' });
    }
    const leadMs = config.syncLeadMs ?? 2500;
    sync.epochStartAt = Date.now() + leadMs;
    sync.epoch += 1;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const source = activeSource();
      const segmenter = activeSegmenter();
      if (typeof source?.restart === 'function') source.restart();
      segmenter?.reset();
      console.log(
        `[wifi-audio] sync epoch ${sync.epoch} started (${new Date().toISOString()})`
      );
    }, leadMs);
    res.json({
      ok: true,
      epoch: sync.epoch,
      epochStartAt: sync.epochStartAt,
      leadMs,
    });
  });

  app.get('/segment/:id', requireAuth, (req, res) => {
    const segmenter = activeSegmenter();
    if (!segmenter)
      return res.status(503).json({ error: 'Segments not available' });
    const data = segmenter.get(req.params.id);
    if (!data)
      return res
        .status(404)
        .json({ error: 'Segment expired — rejoin at the live edge' });
    res.set('Content-Type', segmenter.contentType);
    res.set('Content-Length', String(data.length));
    res.set('Cache-Control', 'private, no-store');
    segmentBytesTransferred += data.length;
    res.send(data);
  });

  const startedAt = Date.now();
  app.get('/api/status', (req, res) => {
    const source = activeSource();
    const segmenter = activeSegmenter();
    const info = source?.info() ?? null;
    const runtimeStats = getRuntimeStats();
    res.json({
      ok: true,
      startedAt,
      serverTime: Date.now(),
      mode: config.mode,
      playbackMode: config.playbackMode ?? 'stream',
      source: info,
      clients: runtimeStats.clients,
      totalBytes: broadcaster.totalBytes,
      transferredBytes: runtimeStats.transferredBytes,
      url: primaryUrl,
      lanAddresses: config.lanAddresses ?? [],
      pinEnabled: auth.enabled,
      authed: auth.enabled
        ? auth.verify(parseCookies(req.headers.cookie || '')[COOKIE_NAME])
        : true,
      bufferTarget: config.bufferTarget,
      segmentMs: segmenter?.segmentMs ?? config.segmentMs,
      playoutDelayMs: segmenter?.playoutDelayMs ?? config.playoutDelayMs,
      scheduledPlayback: Boolean(segmenter?.wavFormat),
      note: config.note ?? null,
      epoch: sync.epoch,
      epochStartAt: sync.epochStartAt,
      volume: config.volume,
      volumeSupported: config.mode === 'ffmpeg' && Boolean(source),
      uptime: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get('/api/time', (req, res) => {
    res.json({ t: Date.now() });
  });

  app.post('/api/auth', (req, res) => {
    if (!auth.enabled)
      return res.status(400).json({ error: 'No PIN configured' });
    const { pin } = req.body ?? {};
    if (!auth.checkPin(pin))
      return res.status(403).json({ error: 'Wrong PIN' });
    res.set(
      'Set-Cookie',
      `${COOKIE_NAME}=${auth.issue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
    );
    res.json({ ok: true });
  });

  app.post('/api/volume', (req, res) => {
    if (config.mode !== 'ffmpeg' || !activeSource()) {
      return res.status(400).json({
        error: 'Server-side volume is only available in live capture mode',
      });
    }
    const volume = Number.parseFloat(req.body?.volume);
    if (!Number.isFinite(volume) || volume < 0.05 || volume > 2) {
      return res
        .status(400)
        .json({ error: 'volume must be a number between 0.05 and 2' });
    }
    config.volume = volume;
    onVolumeChange?.(volume);
    res.json({ ok: true, volume });
  });

  app.get('/api/qr', async (req, res) => {
    try {
      const { default: QRCode } = await import('qrcode');
      const svg = await QRCode.toString(primaryUrl, {
        type: 'svg',
        margin: 1,
        width: 640,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      res
        .type('image/svg+xml')
        .set('Cache-Control', 'public, max-age=300')
        .send(svg);
    } catch (error) {
      res.status(500).json({ error: `QR generation failed: ${error.message}` });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    console.error('[server] error:', error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function staticIndexPath() {
  return path.join(PUBLIC_DIR, 'index.html');
}
