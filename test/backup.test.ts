import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backupPosts, mediaReferences, postDirectory } from '../src/backup.ts'

test('postDirectory uses the UTC post timestamp and requested layout', () => {
  const post = { id: '17977704596464643', timestamp: '2023-07-06T04:35:02Z' }
  assert.equal(
    postDirectory('/work', post, 'tester'),
    join('/work', 'backups/tester/2023/2023-07-06-04-35-02-17977704596464643'),
  )
  assert.equal(postDirectory('/work', post, 'tester', 'archive'), join('/work', 'archive/tester/2023/2023-07-06-04-35-02-17977704596464643'))
  assert.throws(() => postDirectory('/work', post, '..'), /Unsafe Threads username/)
})

test('mediaReferences includes reply media and deduplicates URLs', () => {
  assert.deepEqual(mediaReferences({
    id: 'post1',
    media_url: 'https://cdn.example/a.jpg',
    thumbnail_url: 'https://cdn.example/a.jpg',
    children: { data: [{ id: 'child1', gif_url: 'https://cdn.example/b.gif' }] },
  }), [
    { id: 'post1', kind: 'media', url: 'https://cdn.example/a.jpg' },
    { id: 'child1', kind: 'gif', url: 'https://cdn.example/b.gif' },
  ])
  assert.deepEqual(mediaReferences({
    id: 'post1',
    replies: [{
      id: 'reply1',
      media_url: 'https://cdn.example/r.jpg',
      quoted_post: { id: 'other', media_url: 'https://cdn.example/quoted.jpg' },
      children: { data: [{ id: 'reply-child', thumbnail_url: 'https://cdn.example/t.jpg' }] },
    }],
  }), [
    { id: 'reply1', kind: 'media', url: 'https://cdn.example/r.jpg' },
    { id: 'reply-child', kind: 'thumbnail', url: 'https://cdn.example/t.jpg' },
  ])
})

test('backup logs each UTC day once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const logs: string[] = []
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'one', timestamp: '2026-08-07T01:02:03Z' },
    { id: 'two', timestamp: '2026-08-07T23:59:59Z' },
    { id: 'three', timestamp: '2026-08-06T23:59:59Z' },
  ] })
  console.log = (message) => logs.push(String(message))
  try {
    await backupPosts(cwd, 'token', 'tester')
    assert.deepEqual(logs, ['Download 2026-08-07 post.', 'Download 2026-08-06 post.'])
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    await rm(cwd, { recursive: true })
  }
})

test('incremental stops at existing, resume skips existing, and full overwrites all', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const existing = { id: 'old', timestamp: '2026-08-06T01:02:03Z' }
  const existingDirectory = postDirectory(cwd, existing, 'tester')
  await mkdir(existingDirectory, { recursive: true })
  await writeFile(join(existingDirectory, 'old.json'), '{}')

  const originalFetch = globalThis.fetch
  let pageRequests = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/me/threads')) {
      pageRequests++
      return Response.json({
        data: [{ id: 'new', timestamp: '2026-08-07T01:02:03Z' }, existing],
        paging: { next: 'https://graph.threads.net/page-2' },
      })
    }
    if (url.includes('/page-2')) {
      pageRequests++
      return Response.json({ data: [{ id: 'older', timestamp: '2026-08-05T01:02:03Z' }] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  try {
    const incremental = await backupPosts(cwd, 'token', 'tester')
    assert.deepEqual(incremental, { saved: 1, failed: 0, stoppedAtExisting: true })
    assert.equal(pageRequests, 1)

    pageRequests = 0
    const resumed = await backupPosts(cwd, 'token', 'tester', false, true)
    assert.deepEqual(resumed, { saved: 1, failed: 0, stoppedAtExisting: false })
    assert.equal(pageRequests, 2)

    pageRequests = 0
    const full = await backupPosts(cwd, 'token', 'tester', true)
    assert.deepEqual(full, { saved: 3, failed: 0, stoppedAtExisting: false })
    assert.equal(pageRequests, 2)
    const backup = JSON.parse(await readFile(join(postDirectory(cwd, existing, 'tester'), 'old.json'), 'utf8')) as { id: string }
    assert.equal(backup.id, 'old')
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})

test('media failure leaves no JSON completion marker', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const post = { id: 'broken', timestamp: '2026-08-07T01:02:03Z', media_url: 'https://cdn.example/broken.jpg' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).includes('/me/threads')
    ? Response.json({ data: [post] })
    : new Response('nope', { status: 503 })
  try {
    assert.deepEqual(await backupPosts(cwd, 'token', 'tester'), { saved: 0, failed: 1, stoppedAtExisting: false })
    await assert.rejects(readFile(join(postDirectory(cwd, post, 'tester'), 'broken.json')), { code: 'ENOENT' })
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})

test('carousel media uses the child ID and Content-Type extension', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const post = {
    id: 'carousel',
    timestamp: '2026-08-07T01:02:03Z',
    children: { data: [{ id: 'child1' }] },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/me/threads')) return Response.json({ data: [post] })
    if (url.includes('/v1.0/child1')) return Response.json({ id: 'child1', media_url: 'https://cdn.example/no-extension' })
    if (url === 'https://cdn.example/no-extension') {
      return new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  try {
    assert.deepEqual(await backupPosts(cwd, 'token', 'tester'), { saved: 1, failed: 0, stoppedAtExisting: false })
    assert.equal(await readFile(join(postDirectory(cwd, post, 'tester'), 'child1-media.jpg'), 'utf8'), 'image-bytes')
    const saved = JSON.parse(await readFile(join(postDirectory(cwd, post, 'tester'), 'carousel.json'), 'utf8')) as {
      children: { data: Array<{ media_url: string }> }
      replies: unknown[]
    }
    assert.equal(saved.children.data[0].media_url, 'https://cdn.example/no-extension')
    assert.deepEqual(saved.replies, [])
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})

test('posts with replies store the conversation and download reply media', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const post = {
    id: 'post1',
    timestamp: '2026-08-07T01:02:03Z',
    has_replies: true,
    media_url: 'https://cdn.example/post.jpg',
  }
  const quiet = { id: 'quiet', timestamp: '2026-08-07T02:02:03Z', has_replies: false }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/me/threads')) return Response.json({ data: [post, quiet] })
    if (url.includes('/conversation')) {
      return Response.json({ data: [{ id: 'reply1', text: 'hello', media_url: 'https://cdn.example/reply.jpg' }] })
    }
    if (url === 'https://cdn.example/post.jpg') return new Response('post-bytes', { headers: { 'content-type': 'image/jpeg' } })
    if (url === 'https://cdn.example/reply.jpg') return new Response('reply-bytes', { headers: { 'content-type': 'image/jpeg' } })
    throw new Error(`Unexpected URL: ${url}`)
  }
  try {
    assert.deepEqual(await backupPosts(cwd, 'token', 'tester'), { saved: 2, failed: 0, stoppedAtExisting: false })
    const directory = postDirectory(cwd, post, 'tester')
    assert.equal(await readFile(join(directory, 'post1-media.jpg'), 'utf8'), 'post-bytes')
    assert.equal(await readFile(join(directory, 'reply1-media.jpg'), 'utf8'), 'reply-bytes')
    const saved = JSON.parse(await readFile(join(directory, 'post1.json'), 'utf8')) as { replies: Array<{ text: string }> }
    assert.equal(saved.replies[0].text, 'hello')
    const skipped = JSON.parse(await readFile(join(postDirectory(cwd, quiet, 'tester'), 'quiet.json'), 'utf8')) as { replies: unknown[] }
    assert.deepEqual(skipped.replies, [])
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})

test('resume refreshes replies without downloading existing post media again', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const post = {
    id: 'post1',
    timestamp: '2026-08-07T01:02:03Z',
    has_replies: true,
    text: 'original',
    media_url: 'https://cdn.example/post.jpg',
  }
  const directory = postDirectory(cwd, post, 'tester')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'post1.json'), `${JSON.stringify({ id: 'post1', text: 'original' })}\n`)
  const fetched: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    fetched.push(url)
    if (url.includes('/me/threads')) return Response.json({ data: [post] })
    if (url.includes('/conversation')) return Response.json({ data: [{ id: 'reply1', text: 'hello', media_url: 'https://cdn.example/reply.jpg' }] })
    if (url === 'https://cdn.example/reply.jpg') return new Response('reply-bytes', { headers: { 'content-type': 'image/jpeg' } })
    throw new Error(`Unexpected URL: ${url}`)
  }
  try {
    assert.deepEqual(await backupPosts(cwd, 'token', 'tester', false, true), { saved: 0, failed: 0, stoppedAtExisting: false })
    assert.equal(fetched.some((url) => url.includes('post.jpg')), false)
    assert.equal(await readFile(join(directory, 'reply1-media.jpg'), 'utf8'), 'reply-bytes')
    const saved = JSON.parse(await readFile(join(directory, 'post1.json'), 'utf8')) as { text: string, replies: Array<{ text: string }> }
    assert.equal(saved.text, 'original')
    assert.equal(saved.replies[0].text, 'hello')

    const before = fetched.length
    assert.deepEqual(await backupPosts(cwd, 'token', 'tester', false, true), { saved: 0, failed: 0, stoppedAtExisting: false })
    assert.equal(fetched.slice(before).some((url) => url.includes('reply.jpg')), false)
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})

test('a missing reply permission stops the account before writing JSON', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-backup-'))
  const post = { id: 'post1', timestamp: '2026-08-07T01:02:03Z', has_replies: true }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/me/threads')) return Response.json({ data: [post] })
    return new Response(JSON.stringify({
      error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 },
    }), { status: 400 })
  }
  try {
    await assert.rejects(backupPosts(cwd, 'token', 'tester'), /Delete \.credentials\/tester\.json and log in again/)
    await assert.rejects(readFile(join(postDirectory(cwd, post, 'tester'), 'post1.json')), { code: 'ENOENT' })
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})
