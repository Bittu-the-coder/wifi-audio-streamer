import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Broadcaster } from '../src/broadcaster.js'

function fakeRes() {
  const pt = new PassThrough()
  return {
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    flushHeaders() {},
    write: (chunk) => pt.write(chunk),
    on: (ev, fn) => { pt.on(ev, fn); return this },
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    stream: pt,
  }
}

test('broadcaster fans out chunks to all clients and tracks count', async () => {
  const b = new Broadcaster()
  const r1 = fakeRes()
  const r2 = fakeRes()

  const id1 = b.addClient(r1, { contentType: 'audio/mpeg' })
  b.addClient(r2, { contentType: 'audio/mpeg' })
  assert.equal(b.count, 2)

  b.push(Buffer.from('aaaa'))
  b.push(Buffer.from('bbbb'))

  const got1 = []
  const got2 = []
  r1.stream.on('data', (c) => got1.push(c.toString()))
  r2.stream.on('data', (c) => got2.push(c.toString()))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(got1.join(''), 'aaaabbbb')
  assert.equal(got2.join(''), 'aaaabbbb')

  b.removeClient(id1)
  assert.equal(b.count, 1)
  assert.equal(b.hasClients(), true)
})

test('initial chunk is written before live data', async () => {
  const b = new Broadcaster()
  const r = fakeRes()
  b.addClient(r, { contentType: 'audio/wav', initialChunk: Buffer.from('HEADER') })
  b.push(Buffer.from('data'))

  const parts = []
  r.stream.on('data', (c) => parts.push(c.toString()))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(parts.join(''), 'HEADERdata')
})

test('removes dead clients on close and fires events', async () => {
  const b = new Broadcaster()
  const events = []
  b.on('connect', (_id, n) => events.push(`+${n}`))
  b.on('disconnect', (_id, n) => events.push(`-${n}`))

  const r = fakeRes()
  b.addClient(r, { contentType: 'audio/mpeg' })
  assert.deepEqual(events, ['+1'])
  r.stream.destroy() // triggers 'close'
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(b.count, 0)
  assert.deepEqual(events, ['+1', '-0'])
})

test('drops chunks for a stalled client instead of buffering forever', () => {
  const b = new Broadcaster({ maxBacklog: 32 })
  const r = fakeRes()
  r.writableLength = 10_000 // simulate a backed-up socket
  const id = b.addClient(r, { contentType: 'audio/mpeg' })

  b.push(Buffer.alloc(16))
  b.push(Buffer.alloc(16))

  const client = b.clients.get(id)
  assert.equal(client.droppedBytes, 32)
})
