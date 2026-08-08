import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  authUrl,
  credentialsFromToken,
  exchangeLongLivedToken,
  fetchThreadMedia,
  fetchThreadsProfile,
  fetchThreadsPage,
  refreshLongLivedToken,
} from '../src/threads.ts'

test('authUrl requests threads_basic and protects the callback with state', () => {
  const url = new URL(authUrl('app123', 'https://example.com/oauth/callback', 'state123'))
  assert.equal(url.origin, 'https://www.threads.net')
  assert.equal(url.searchParams.get('client_id'), 'app123')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/oauth/callback')
  assert.equal(url.searchParams.get('scope'), 'threads_basic')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('state'), 'state123')
})

test('credentialsFromToken records an absolute expiry', () => {
  const now = new Date('2026-08-07T00:00:00Z')
  assert.deepEqual(credentialsFromToken({ access_token: 'token', expires_in: 60 }, 'user1', 'tester', now), {
    access_token: 'token',
    token_type: 'bearer',
    user_id: 'user1',
    username: 'tester',
    obtained_at: '2026-08-07T00:00:00.000Z',
    expires_at: '2026-08-07T00:01:00.000Z',
  })
})

test('Threads requests use bearer auth without putting the token in the URL', async () => {
  const requests: Array<{ url: string, authorization: string | null }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({ url: String(input), authorization: headers.get('authorization') })
    return Response.json({ data: [] })
  }
  try {
    await fetchThreadsPage('secret-token')
    await fetchThreadsPage('secret-token', 'https://graph.threads.net/page-2?after=cursor&access_token=secret-token')
    await fetchThreadMedia('child1', 'secret-token')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests.length, 3)
  assert.ok(requests.every(({ url }) => !url.includes('secret-token')))
  assert.ok(requests.every(({ authorization }) => authorization === 'Bearer secret-token'))
  assert.ok(!requests[0].url.includes('has_replies'))
})

test('long-lived token exchange and refresh use the required query parameter', async () => {
  const requests: Array<{ url: URL, authorization: string | null }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), authorization: new Headers(init?.headers).get('authorization') })
    return Response.json({ access_token: 'new-token', expires_in: 5_184_000 })
  }
  try {
    await exchangeLongLivedToken('app-secret', 'short-token')
    await refreshLongLivedToken('long-token')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests[0].url.pathname, '/access_token')
  assert.equal(requests[0].url.searchParams.get('grant_type'), 'th_exchange_token')
  assert.equal(requests[0].url.searchParams.get('client_secret'), 'app-secret')
  assert.equal(requests[0].url.searchParams.get('access_token'), 'short-token')
  assert.equal(requests[1].url.pathname, '/refresh_access_token')
  assert.equal(requests[1].url.searchParams.get('grant_type'), 'th_refresh_token')
  assert.equal(requests[1].url.searchParams.get('access_token'), 'long-token')
  assert.ok(requests.every(({ authorization }) => authorization === null))
})

test('fetchThreadsProfile requests the username with a query token', async () => {
  let requestedUrl = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    requestedUrl = String(input)
    return Response.json({ id: 'user1', username: 'tester' })
  }
  try {
    assert.deepEqual(await fetchThreadsProfile('profile-token'), { id: 'user1', username: 'tester' })
  } finally {
    globalThis.fetch = originalFetch
  }
  const url = new URL(requestedUrl)
  assert.equal(url.pathname, '/v1.0/me')
  assert.equal(url.searchParams.get('fields'), 'id,username')
  assert.equal(url.searchParams.get('access_token'), 'profile-token')
})
