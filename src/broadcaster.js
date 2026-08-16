import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'

/**
 * Fans a single audio source out to many HTTP clients.
 *
 * Backpressure: if a client's socket buffer grows beyond `maxBacklog` bytes
 * (slow / stalled phone), chunks are dropped for that client instead of
 * buffering forever. It's a live stream — dropping is the right behaviour.
 */
export class Broadcaster extends EventEmitter {
  constructor({ maxBacklog = 512 * 1024, wsServer = null } = {}) {
    super()
    this.maxBacklog = maxBacklog
    this.clients = new Map()
    this.wsServer = wsServer
    this.totalBytes = 0

    if (this.wsServer) {
      this.wsServer.on('connect', (id) => this.emit('connect', id, this.count))
      this.wsServer.on('disconnect', (id) => this.emit('disconnect', id, this.count))
    }
  }

  setWsServer(wsServer) {
    this.wsServer = wsServer
    if (this.wsServer) {
      this.wsServer.on('connect', (id) => this.emit('connect', id, this.count))
      this.wsServer.on('disconnect', (id) => this.emit('disconnect', id, this.count))
    }
  }

  /**
   * Register a new HTTP client response. `initialChunk` (optional) is written
   * before the live stream so WAV clients get a valid header first.
   */
  addClient(res, { contentType, initialChunk = null } = {}) {
    const id = crypto.randomUUID()
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Accel-Buffering': 'no',
      'Accept-Ranges': 'none',
    })
    res.flushHeaders()
    if (initialChunk) res.write(initialChunk)

    const client = { id, res, connectedAt: Date.now(), droppedBytes: 0 }
    this.clients.set(id, client)
    this.emit('connect', id, this.count)

    res.on('close', () => this.removeClient(id))
    return id
  }

  removeClient(id) {
    if (!this.clients.has(id)) return
    this.clients.delete(id)
    this.emit('disconnect', id, this.count)
  }

  push(chunk) {
    this.totalBytes += chunk.length

    // 1. WebSocket broadcast
    if (this.wsServer) {
      this.wsServer.broadcast(chunk)
    }

    // 2. HTTP response broadcast
    if (this.clients.size > 0) {
      for (const [id, client] of this.clients) {
        if (client.res.writableEnded || client.res.destroyed) {
          this.removeClient(id)
          continue
        }
        if (client.res.writableLength > this.maxBacklog) {
          client.droppedBytes += chunk.length
          continue
        }
        client.res.write(chunk)
      }
    }
  }

  hasClients() {
    return this.count > 0
  }

  get count() {
    const wsCount = this.wsServer ? this.wsServer.count : 0
    return this.clients.size + wsCount
  }

  stats() {
    return { clients: this.count, totalBytes: this.totalBytes }
  }
}
