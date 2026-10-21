const graphBaseUrl = 'https://graph.threads.net'

export type ThreadsToken = {
  access_token: string
  token_type?: string
  expires_in?: number
  user_id?: string
}

export type Credentials = {
  access_token: string
  token_type: string
  user_id: string
  username?: string
  obtained_at: string
  expires_at: string
}

export type ThreadsProfile = { id: string, username: string }

export type ThreadsPost = {
  id: string
  timestamp?: string
  media_type?: string
  media_url?: string
  gif_url?: string
  thumbnail_url?: string
  has_replies?: boolean
  replies?: ThreadsPost[]
  children?: { data?: ThreadsPost[] }
  [key: string]: unknown
}

export type ThreadsPage = {
  data?: ThreadsPost[]
  paging?: { next?: string, cursors?: { before?: string, after?: string } }
}

const mediaFields = 'id,media_type,media_url,gif_url,thumbnail_url'
const postFields = [
  mediaFields,
  'media_product_type',
  'permalink',
  'owner',
  'username',
  'text',
  'timestamp',
  'shortcode',
  'children',
  'is_quote_post',
  'quoted_post',
  'reposted_post',
  'alt_text',
  'link_attachment_url',
  'poll_attachment{option_a,option_b,option_c,option_d,option_a_votes_percentage,option_b_votes_percentage,option_c_votes_percentage,option_d_votes_percentage,expiration_timestamp}',
  'location_id',
  'topic_tag',
  'is_verified',
  'profile_picture_url',
  'has_replies',
].join(',')

const replyFields = [
  'id',
  'text',
  'username',
  'permalink',
  'timestamp',
  'media_product_type',
  'media_type',
  'media_url',
  'shortcode',
  'thumbnail_url',
  'children',
  'has_replies',
  'root_post',
  'replied_to',
  'is_reply',
  'is_reply_owned_by_me',
  'hide_status',
].join(',')

async function graphJson<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`Threads API failed (${response.status}): ${await response.text()}`)
  return response.json() as Promise<T>
}

/** Build the official Threads OAuth authorization URL. */
export function authUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL('https://www.threads.net/oauth/authorize')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'threads_basic,threads_read_replies')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  return url.toString()
}

/** Exchange an authorization code for a short-lived user token. */
export function exchangeCode(appId: string, appSecret: string, redirectUri: string, code: string): Promise<ThreadsToken> {
  return graphJson(`${graphBaseUrl}/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    }),
  })
}

/** Exchange a short-lived user token for a long-lived token. */
export function exchangeLongLivedToken(appSecret: string, accessToken: string): Promise<ThreadsToken> {
  const url = new URL(`${graphBaseUrl}/access_token`)
  url.searchParams.set('grant_type', 'th_exchange_token')
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('access_token', accessToken)
  return graphJson(url)
}

/** Refresh an unexpired long-lived Threads token. */
export function refreshLongLivedToken(accessToken: string): Promise<ThreadsToken> {
  const url = new URL(`${graphBaseUrl}/refresh_access_token`)
  url.searchParams.set('grant_type', 'th_refresh_token')
  url.searchParams.set('access_token', accessToken)
  return graphJson(url)
}

/** Build persisted credentials from a token response. */
export function credentialsFromToken(token: ThreadsToken, userId: string, username?: string, now = new Date()): Credentials {
  const expiresIn = token.expires_in ?? 5_184_000
  return {
    access_token: token.access_token,
    token_type: token.token_type ?? 'bearer',
    user_id: userId,
    username,
    obtained_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  }
}

/** Fetch the authenticated Threads profile. */
export function fetchThreadsProfile(accessToken: string): Promise<ThreadsProfile> {
  const url = new URL(`${graphBaseUrl}/v1.0/me`)
  url.searchParams.set('fields', 'id,username')
  url.searchParams.set('access_token', accessToken)
  return graphJson(url)
}

/** Fetch one page of the authenticated user's posts. */
export function fetchThreadsPage(accessToken: string, nextUrl?: string): Promise<ThreadsPage> {
  const url = nextUrl ? new URL(nextUrl) : new URL(`${graphBaseUrl}/v1.0/me/threads`)
  url.searchParams.delete('access_token')
  if (!nextUrl) {
    url.searchParams.set('fields', postFields)
    url.searchParams.set('limit', '100')
  }
  return graphJson(url, { headers: { authorization: `Bearer ${accessToken}` } })
}

/** Fetch every reply on a post, oldest first. Nested replies are included flat. */
export async function fetchThreadReplies(id: string, accessToken: string): Promise<ThreadsPost[]> {
  const replies: ThreadsPost[] = []
  const seenCursors = new Set<string>()
  let nextUrl: string | undefined
  let after: string | undefined
  do {
    const url = nextUrl
      ? new URL(nextUrl)
      : new URL(`${graphBaseUrl}/v1.0/${encodeURIComponent(id)}/conversation`)
    url.searchParams.delete('access_token')
    if (!nextUrl) {
      url.searchParams.set('fields', replyFields)
      url.searchParams.set('limit', '100')
      url.searchParams.set('reverse', 'false')
      if (after) url.searchParams.set('after', after)
    }
    const page = await graphJson<ThreadsPage>(url, { headers: { authorization: `Bearer ${accessToken}` } })
    replies.push(...page.data ?? [])
    nextUrl = page.paging?.next
    const cursor = page.paging?.cursors?.after
    if (nextUrl) {
      after = undefined
    } else if (cursor && !seenCursors.has(cursor) && (page.data?.length ?? 0) > 0) {
      seenCursors.add(cursor)
      after = cursor
    } else {
      after = undefined
    }
  } while (nextUrl || after)
  return replies
}

/** Fetch downloadable fields for one carousel child. */
export function fetchThreadMedia(id: string, accessToken: string): Promise<ThreadsPost> {
  const url = new URL(`${graphBaseUrl}/v1.0/${encodeURIComponent(id)}`)
  url.searchParams.set('fields', mediaFields)
  return graphJson(url, { headers: { authorization: `Bearer ${accessToken}` } })
}
