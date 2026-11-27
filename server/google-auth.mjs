#!/usr/bin/env node
// One-time Google sign-in for Duet. Usage:
//   node google-auth.mjs ~/Downloads/client_secret_XXXX.json
// Opens your browser, you approve Calendar + Gmail, and DUET_CONFIG/google.json is written (mode 600).
// The client file is the "Desktop app" OAuth client downloaded from Google Cloud Console.
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { SCOPES } from './google.mjs'

const CONFIG = process.env.DUET_CONFIG || path.join(os.homedir(), '.config', 'duet')
const file = process.argv[2]
if (!file) { console.error('usage: node google-auth.mjs <client_secret.json>'); process.exit(1) }
const raw = JSON.parse(readFileSync(file, 'utf8'))
const client = raw.installed || raw.web || raw
if (!client.client_id || !client.client_secret) { console.error('That file has no client_id / client_secret.'); process.exit(1) }

const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = randomBytes(16).toString('hex')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/callback') { res.writeHead(404); return res.end() }
  if (url.searchParams.get('state') !== state) { res.writeHead(400); return res.end('state mismatch') }
  const code = url.searchParams.get('code')
  if (!code) { res.writeHead(400); res.end(`Sign-in cancelled: ${url.searchParams.get('error') || 'no code'}`); return finish(1) }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    })
    const tok = await tokenRes.json()
    if (!tok.refresh_token) throw new Error(tok.error_description || tok.error || 'Google returned no refresh token')
    mkdirSync(CONFIG, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(CONFIG, 'google.json'), JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tok.refresh_token, scope: tok.scope }, null, 2), { mode: 0o600 })
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h2>Duet is connected to Google. You can close this tab.</h2>')
    console.log(`Saved ${path.join(CONFIG, 'google.json')}`)
    finish(0)
  } catch (e) {
    res.writeHead(500); res.end(String(e.message))
    console.error('Failed:', e.message)
    finish(1)
  }
})

let redirect = ''
function finish(code) { setTimeout(() => { server.close(); process.exit(code) }, 300) }

server.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${server.address().port}/callback`
  const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`
  console.log('Opening your browser to sign in to Google. If it does not open, visit:\n\n' + auth + '\n')
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [auth], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
})
