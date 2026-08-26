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

test('mediaReferences includes children and deduplicates URLs', () => {
  assert.deepEqual(mediaReferences({
    id: 'post1',
    media_url: 'https://cdn.example/a.jpg',
    thumbnail_url: 'https://cdn.example/a.jpg',
    children: { data: [{ id: 'child1', gif_url: 'https://cdn.example/b.gif' }] },
  }), [
    { id: 'post1', kind: 'media', url: 'https://cdn.example/a.jpg' },
    { id: 'child1', kind: 'gif', url: 'https://cdn.example/b.gif' },
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
    }
    assert.equal(saved.children.data[0].media_url, 'https://cdn.example/no-extension')
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true })
  }
})
