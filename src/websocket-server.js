import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { parseCookies, COOKIE_NAME } from './auth.js'

export class AudioWebSocketServer extends EventEmitter {
  constructor({ auth = null } = {}) {
    super()
    this.auth = auth
    this.wss = null
    this.clients = new Map() // id -> { ws, connectedAt, droppedBytes, isAlive }
    this.totalBytes = 0
    this.pingInterval = null
    this.format = { supported: false }
  }

  setFormat(info = {}) {
    const supported = (info.contentType === 'audio/pcm' || info.contentType === 'audio/wav') && info.bitsPerSample === 16
    this.format = {
      supported,
      codec: supported ? 'pcm_s16le' : null,
      sampleRate: info.sampleRate ?? 48000,
      channels: info.channels ?? 2,
      bitsPerSample: info.bitsPerSample ?? 16,
      frameMs: info.frameMs ?? null,
    }
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
      if (url.pathname !== '/ws/audio') {
        // Not our WS path
        return
      }

      // Check auth if PIN enabled
      if (this.auth && this.auth.enabled) {
        const token = parseCookies(request.headers.cookie || '')[COOKIE_NAME]
        if (!this.auth.verify(token)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const id = crypto.randomUUID()
      const client = {
        id,
        ws,
        connectedAt: Date.now(),
        droppedBytes: 0,
        isAlive: true,
        ip: req.socket.remoteAddress,
      }

      this.clients.set(id, client)
      this.emit('connect', id, this.clients.size)

      ws.isAlive = true
      ws.on('pong', () => {
        client.isAlive = true
      })

      ws.on('close', () => {
        this.clients.delete(id)
        this.emit('disconnect', id, this.clients.size)
      })

      ws.on('error', () => {
        this.clients.delete(id)
        this.emit('disconnect', id, this.clients.size)
      })

      // Send initial metadata message
      try {
        ws.send(JSON.stringify({
          type: 'init',
          serverTime: Date.now(),
          clientId: id,
          audio: this.format,
        }))
      } catch {
        /* client disconnected immediately */
      }
    })

    // Heartbeat setup
    this.pingInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate()
          this.clients.delete(id)
          this.emit('disconnect', id, this.clients.size)
          continue
        }
        client.isAlive = false
        try {
          client.ws.ping()
        } catch {
          this.clients.delete(id)
          this.emit('disconnect', id, this.clients.size)
        }
      }
    }, 15000)
    if (this.pingInterval.unref) this.pingInterval.unref()
  }

  broadcast(chunk) {
    if (!this.clients.size || !this.format.supported) return
    this.totalBytes += chunk.length

    for (const [id, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        // Backpressure check: if bufferedAmount > 256KB, drop chunk to keep latency ultra low
        if (client.ws.bufferedAmount > 64 * 1024) {
          client.droppedBytes += chunk.length
          continue
        }
        try {
          client.ws.send(chunk, { binary: true })
        } catch {
          this.clients.delete(id)
          this.emit('disconnect', id, this.clients.size)
        }
      }
    }
  }

  get count() {
    return this.clients.size
  }

  close() {
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.wss) {
      for (const [, client] of this.clients) {
        try { client.ws.close() } catch {}
      }
      this.wss.close()
    }
  }
}
