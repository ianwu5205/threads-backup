import { access, readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { debuglog } from 'node:util'
import { atomicDownload, atomicWrite } from './files.ts'
import { fetchThreadMedia, fetchThreadReplies, fetchThreadsPage, type ThreadsPost } from './threads.ts'

const debug = debuglog('threads-backup')

export type BackupSummary = { saved: number, failed: number, stoppedAtExisting: boolean }

type MediaReference = { id: string, kind: 'media' | 'gif' | 'thumbnail', url: string }

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Unsafe Threads media ID: ${id}`)
  return id
}

function safeAccount(account: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(account) || account === '.' || account === '..') {
    throw new Error(`Unsafe Threads username: ${account}`)
  }
  return account
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Return the requested output directory for one post. */
export function postDirectory(cwd: string, post: ThreadsPost, account: string, backupFolder = 'backups'): string {
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
  return join(resolve(cwd, backupFolder), safeAccount(account), String(date.getUTCFullYear()), `${stamp}-${safeId(post.id)}`)
}

function jsonPath(cwd: string, post: ThreadsPost, account: string, backupFolder: string): string {
  return join(postDirectory(cwd, post, account, backupFolder), `${safeId(post.id)}.json`)
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

/** Collect unique media URLs attached to a post, its carousel children, and its replies. */
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
    for (const reply of item.replies ?? []) visit(reply)
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

function isReplyPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('Threads API failed') && /OAuthException|threads_read_replies|does not have permission|\(#10\)|\(#200\)/.test(message)
}

function replyPermissionError(account: string): Error {
  return new Error(`Threads token cannot read replies. Delete .credentials/${account}.json and log in again.`)
}

async function attachReplies(post: ThreadsPost, accessToken: string): Promise<ThreadsPost> {
  if (post.has_replies !== true) return { ...post, replies: [] }
  const replies = await fetchThreadReplies(safeId(post.id), accessToken)
  return {
    ...post,
    replies: await Promise.all(replies.map((reply) => withChildMedia(reply, accessToken))),
  }
}

async function downloadMedia(directory: string, references: MediaReference[], datetime: string, skipExisting = false): Promise<void> {
  for (const media of references) {
    const urlExtension = extname(new URL(media.url).pathname).toLowerCase()
    const knownExtension = /^\.[a-z0-9]{1,5}$/.test(urlExtension) ? urlExtension : undefined
    const path = join(directory, `${media.id}-${media.kind}${knownExtension ?? ''}`)
    if (skipExisting && knownExtension && await exists(path)) continue
    const response = await fetch(media.url)
    if (!response.ok) throw new Error(`Media download failed (${response.status}): ${media.url}`)
    const extension = knownExtension ?? mediaExtension(media.url, response.headers.get('content-type'))
    const file = knownExtension ? path : join(directory, `${media.id}-${media.kind}${extension}`)
    debug(`Download ${datetime} image in ${file}.`)
    await atomicDownload(file, response)
  }
}

async function savePost(cwd: string, post: ThreadsPost, accessToken: string, account: string, backupFolder: string): Promise<void> {
  const enriched = await attachReplies(await withChildMedia(post, accessToken), accessToken)
  const directory = postDirectory(cwd, enriched, account, backupFolder)
  const datetime = new Date(String(enriched.timestamp)).toISOString()
  await downloadMedia(directory, mediaReferences(enriched), datetime)
  const path = jsonPath(cwd, enriched, account, backupFolder)
  debug(`Download ${datetime} post in ${path}.`)
  await atomicWrite(path, `${JSON.stringify(enriched, null, 2)}\n`)
}

async function refreshReplies(cwd: string, post: ThreadsPost, accessToken: string, account: string, backupFolder: string): Promise<void> {
  const path = jsonPath(cwd, post, account, backupFolder)
  const saved = JSON.parse(await readFile(path, 'utf8')) as ThreadsPost
  const enriched = await attachReplies(post, accessToken)
  const directory = postDirectory(cwd, enriched, account, backupFolder)
  const datetime = new Date(String(enriched.timestamp)).toISOString()
  await downloadMedia(directory, mediaReferences({ id: enriched.id, replies: enriched.replies }), datetime, true)
  const updated = { ...saved, has_replies: enriched.has_replies, replies: enriched.replies }
  debug(`Download ${datetime} replies in ${path}.`)
  await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`)
}

/** Back up new posts, all posts, or resume past existing posts. */
export async function backupPosts(cwd: string, accessToken: string, account: string, fullBackup = false, resume = false, backupFolder = 'backups'): Promise<BackupSummary> {
  const summary: BackupSummary = { saved: 0, failed: 0, stoppedAtExisting: false }
  const loggedDays = new Set<string>()
  let nextUrl: string | undefined
  do {
    const page = await fetchThreadsPage(accessToken, nextUrl)
    for (const post of page.data ?? []) {
      const savedAlready = !fullBackup && await exists(jsonPath(cwd, post, account, backupFolder))
      if (savedAlready && !resume) {
        summary.stoppedAtExisting = true
        return summary
      }
      try {
        const day = new Date(String(post.timestamp)).toISOString().slice(0, 10)
        if (!loggedDays.has(day)) {
          console.log(`Download ${day} post.`)
          loggedDays.add(day)
        }
        if (savedAlready) await refreshReplies(cwd, post, accessToken, account, backupFolder)
        else {
          await savePost(cwd, post, accessToken, account, backupFolder)
          summary.saved++
        }
      } catch (error) {
        if (isReplyPermissionError(error)) throw replyPermissionError(account)
        summary.failed++
        debug(`Post ${post.id} failed: ${error instanceof Error ? error.message : String(error)}.`)
      }
    }
    nextUrl = page.paging?.next
  } while (nextUrl)
  return summary
}
