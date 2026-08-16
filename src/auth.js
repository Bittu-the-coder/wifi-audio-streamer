import crypto from 'node:crypto'

/**
 * Optional shared-PIN gate for the stream (keeps randos on the same WiFi out).
 * Off by default; enable with AUTH_PIN in .env.
 *
 * Tokens are HMAC(pin) signed with a per-boot secret, stored in an HttpOnly
 * cookie. It's a convenience lock for a trusted LAN, not a security system.
 */
export function createAuth({ pin = '', secret = '' } = {}) {
  if (!pin) return { enabled: false, issue: null, verify: () => true, checkPin: () => false }

  const key = secret || crypto.randomBytes(32).toString('hex')
  const expected = crypto.createHmac('sha256', key).update(String(pin)).digest('hex')

  const hmac = (value) => crypto.createHmac('sha256', key).update(String(value)).digest('hex')

  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a))
    const bb = Buffer.from(String(b))
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
  }

  return {
    enabled: true,
    issue: () => expected,
    verify: (token) => safeEqual(token, expected),
    checkPin: (input) => safeEqual(hmac(input), expected),
  }
}

/** Minimal cookie parser (avoids a cookie-parser dependency). */
export function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export const COOKIE_NAME = 'stream_auth'
