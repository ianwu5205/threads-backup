import { access } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { atomicDownload, atomicWrite } from './files.ts'
import { fetchThreadMedia, fetchThreadsPage, type ThreadsPost } from './threads.ts'

export type BackupSummary = { saved: number, failed: number, stoppedAtExisting: boolean }

type MediaReference = { id: string, kind: 'media' | 'gif' | 'thumbnail', url: string }

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe Threads media ID: ${id}`)
  return id
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Return the requested output directory for one post. */
export function postDirectory(cwd: string, post: ThreadsPost): string {
  const date = new Date(String(post.timestamp ?? ''))
  if (Number.isNaN(date.valueOf())) throw new Error(`Post ${post.id} has an invalid timestamp`)
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('-')
  return join(cwd, '.out', String(date.getUTCFullYear()), `${stamp}-${safeId(post.id)}`)
}

function jsonPath(cwd: string, post: ThreadsPost): string {
  return join(postDirectory(cwd, post), `${safeId(post.id)}.json`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function withChildMedia(post: ThreadsPost, accessToken: string): Promise<ThreadsPost> {
  const children = post.children?.data
  if (!children?.length) return post
  return {
    ...post,
    children: {
      data: await Promise.all(children.map(async (child) => ({
        ...child,
        ...await fetchThreadMedia(safeId(child.id), accessToken),
      }))),
    },
  }
}

/** Collect unique media URLs attached directly to a post and its carousel children. */
export function mediaReferences(post: ThreadsPost): MediaReference[] {
  const references: MediaReference[] = []
  const seen = new Set<string>()
  const visit = (item: ThreadsPost): void => {
    for (const [key, kind] of [['media_url', 'media'], ['gif_url', 'gif'], ['thumbnail_url', 'thumbnail']] as const) {
      const url = item[key]
      if (typeof url === 'string' && /^https?:\/\//.test(url) && !seen.has(url)) {
        seen.add(url)
        references.push({ id: safeId(item.id), kind, url })
      }
    }
    for (const child of item.children?.data ?? []) visit(child)
  }
  visit(post)
  return references
}

function mediaExtension(url: string, contentType: string | null): string {
  const extension = extname(new URL(url).pathname).toLowerCase()
  if (/^\.[a-z0-9]{1,5}$/.test(extension)) return extension
  const mimeExtensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  }
  return mimeExtensions[contentType?.split(';', 1)[0].trim().toLowerCase() ?? ''] ?? '.bin'
}

async function savePost(cwd: string, post: ThreadsPost, accessToken: string): Promise<void> {
  const enriched = await withChildMedia(post, accessToken)
  const directory = postDirectory(cwd, enriched)
  for (const media of mediaReferences(enriched)) {
    const response = await fetch(media.url)
    if (!response.ok) throw new Error(`Media download failed (${response.status}): ${media.url}`)
    const path = join(directory, `${media.id}-${media.kind}${mediaExtension(media.url, response.headers.get('content-type'))}`)
    console.log(`${new Date()},INFO,backup.savePost,download ${path}.`)
    await atomicDownload(path, response)
  }
  await atomicWrite(jsonPath(cwd, enriched), `${JSON.stringify(enriched, null, 2)}\n`)
}

/** Back up new posts, all posts, or resume past existing posts. */
export async function backupPosts(cwd: string, accessToken: string, fullBackup = false, resume = false): Promise<BackupSummary> {
  const summary: BackupSummary = { saved: 0, failed: 0, stoppedAtExisting: false }
  let nextUrl: string | undefined
  do {
    const page = await fetchThreadsPage(accessToken, nextUrl)
    for (const post of page.data ?? []) {
      if (!fullBackup && await exists(jsonPath(cwd, post))) {
        if (resume) continue
        summary.stoppedAtExisting = true
        return summary
      }
      try {
        await savePost(cwd, post, accessToken)
        summary.saved++
      } catch (error) {
        summary.failed++
        console.error(`${new Date()},ERROR,backup.backupPosts,post ${post.id} failed: ${error instanceof Error ? error.message : String(error)}.`)
      }
    }
    nextUrl = page.paging?.next
  } while (nextUrl)
  return summary
}
