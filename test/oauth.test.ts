import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCredentials, quickTunnelUrl, tunnelStatus, validateRedirectUri } from '../src/oauth.ts'

test('validateRedirectUri accepts only the exact HTTPS callback path', () => {
  assert.equal(validateRedirectUri('https://backup.example.com/oauth/callback'), 'https://backup.example.com/oauth/callback')
  assert.throws(() => validateRedirectUri('http://backup.example.com/oauth/callback'), /HTTPS/)
  assert.throws(() => validateRedirectUri('https://backup.example.com/wrong'), /oauth\/callback/)
})

test('quickTunnelUrl reads cloudflared text and JSON logs', () => {
  assert.equal(
    quickTunnelUrl('Your quick Tunnel has been created! Visit it at https://random-words.trycloudflare.com'),
    'https://random-words.trycloudflare.com',
  )
  assert.equal(
    quickTunnelUrl('{"message":"https://another-one.trycloudflare.com"}'),
    'https://another-one.trycloudflare.com',
  )
  assert.equal(quickTunnelUrl('still connecting'), undefined)
})

test('tunnelStatus finds active and inactive named tunnels', () => {
  const output = JSON.stringify([
    { name: 'inactive', connections: [] },
    { name: 'active', connections: [{ id: 'connection1' }] },
  ])
  assert.deepEqual(tunnelStatus(output, 'inactive'), { name: 'inactive', connections: [] })
  assert.equal(tunnelStatus(output, 'active')?.connections?.length, 1)
  assert.equal(tunnelStatus(output, 'missing'), undefined)
})

test('getCredentials migrates a legacy file to a username JSON file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-credentials-'))
  const root = join(cwd, '.credentials')
  await writeFile(root, JSON.stringify({
    access_token: 'token',
    token_type: 'bearer',
    user_id: 'old-id',
    obtained_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }), { mode: 0o600 })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'user1', username: 'tester.name' })
  try {
    const credentials = await getCredentials({ appId: 'app', appSecret: 'secret', port: 8787, cwd })
    assert.equal(credentials.username, 'tester.name')
    assert.ok((await stat(root)).isDirectory())
    assert.equal((await stat(root)).mode & 0o777, 0o700)
    const path = join(root, 'tester.name.json')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).user_id, 'user1')
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})
