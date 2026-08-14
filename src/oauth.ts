import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { debuglog } from 'node:util'
import { atomicWrite } from './files.ts'
import {
  authUrl,
  credentialsFromToken,
  exchangeCode,
  exchangeLongLivedToken,
  fetchThreadsProfile,
  refreshLongLivedToken,
  type Credentials,
} from './threads.ts'

const debug = debuglog('threads-backup')
const callbackPath = '/oauth/callback'
const refreshBeforeMs = 7 * 24 * 60 * 60 * 1000

type OAuthConfig = {
  appId: string
  appSecret: string
  port: number
  redirectUri?: string
  tunnelName?: string
  cwd: string
}

type TunnelStatus = { name: string, connections?: unknown[] }

function log(type: 'INFO' | 'WARNING' | 'ERROR', method: string, message: string): void {
  debug(`${new Date()},${type},${method},${message}.`)
}

/** Validate a fixed OAuth callback URL. */
export function validateRedirectUri(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.pathname !== callbackPath) {
    throw new Error(`THREADS_REDIRECT_URI must be an HTTPS URL ending in ${callbackPath}`)
  }
  return url.toString()
}

/** Extract a TryCloudflare URL from cloudflared output. */
export function quickTunnelUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0]
}

/** Read one named tunnel's status from cloudflared JSON output. */
export function tunnelStatus(output: string, name: string): TunnelStatus | undefined {
  const tunnels = JSON.parse(output) as TunnelStatus[]
  return tunnels.find((tunnel) => tunnel.name === name)
}

function installHint(): string {
  if (process.platform === 'darwin') return 'Install cloudflared with: brew install cloudflared'
  if (process.platform === 'win32') return 'Install cloudflared with: winget install --id Cloudflare.cloudflared'
  return 'Install cloudflared: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function runCloudflared(args: string[]): Promise<string> {
  const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new Error(installHint()) : error))
    child.once('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`cloudflared failed (${code ?? 'signal'}): ${stderr.trim()}`)))
  })
}

async function waitForCallback(redirectUri: string, child?: ChildProcessWithoutNullStreams): Promise<void> {
  const healthUrl = new URL('/health', redirectUri)
  for (let attempt = 0; attempt < 30; attempt++) {
    if (child?.exitCode !== null) throw new Error(`cloudflared exited before ${healthUrl.origin} became reachable`)
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) })
      if (response.ok && await response.text() === 'ok') return
    } catch {
      // The connector or DNS route may still be starting.
    }
    await delay(1_000)
  }
  throw new Error(`Fixed tunnel did not reach http://127.0.0.1 through ${healthUrl.origin} within 30 seconds`)
}

async function ensureFixedTunnel(name: string, redirectUri: string, port: number): Promise<ChildProcessWithoutNullStreams | undefined> {
  const status = tunnelStatus(await runCloudflared(['tunnel', 'list', '--output', 'json']), name)
  if (!status) throw new Error(`Cloudflare tunnel not found: ${name}`)
  if (status.connections?.length) {
    await waitForCallback(redirectUri)
    log('INFO', 'oauth.ensureFixedTunnel', `using active tunnel ${name}`)
    return undefined
  }

  const tokenPath = join(tmpdir(), `threads-backup-${randomUUID()}.token`)
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    await runCloudflared(['tunnel', 'token', '--cred-file', tokenPath, name])
    child = spawn('cloudflared', [
      'tunnel',
      '--no-autoupdate',
      '--output', 'json',
      'run',
      '--credentials-file', tokenPath,
      '--url', `http://127.0.0.1:${port}`,
      name,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.resume()
    child.stderr.resume()
    let startError: Error | undefined
    child.once('error', (error: NodeJS.ErrnoException) => {
      startError = error.code === 'ENOENT' ? new Error(installHint()) : error
    })
    await waitForCallback(redirectUri, child)
    if (startError) throw startError
    log('INFO', 'oauth.ensureFixedTunnel', `started tunnel ${name}`)
    return child
  } catch (error) {
    child?.kill('SIGTERM')
    throw error
  } finally {
    await rm(tokenPath, { force: true })
  }
}

async function startQuickTunnel(port: number): Promise<{ process: ChildProcessWithoutNullStreams, redirectUri: string }> {
  const child = spawn('cloudflared', [
    'tunnel',
    '--url', `http://127.0.0.1:${port}`,
    '--no-autoupdate',
    '--output', 'json',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => finish(new Error('cloudflared did not provide a Quick Tunnel URL within 30 seconds')), 30_000)

    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('exit', onExit)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      if (error) {
        child.kill('SIGTERM')
        reject(error)
      } else if (url) {
        resolve({ process: child, redirectUri: `${url}${callbackPath}` })
      }
    }
    const onData = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-16_384)
      const url = quickTunnelUrl(output)
      if (url) finish(undefined, url)
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      finish(error.code === 'ENOENT' ? new Error(installHint()) : error)
    }
    const onExit = (code: number | null): void => finish(new Error(`cloudflared exited before it was ready (${code ?? 'signal'})`))

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function confirmRedirectUri(redirectUri: string): Promise<void> {
  console.log(`\nCallback URL: ${redirectUri}`)
  console.log('Add this exact URL to Meta App > Threads API > Redirect Callback URLs.')
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    await prompt.question('Press Enter when it is saved in Meta: ')
  } finally {
    prompt.close()
  }
}

async function readCredentialFile(path: string): Promise<Credentials | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Credentials>
    if (!value.access_token || !value.user_id || !value.expires_at) return undefined
    return value as Credentials
  } catch {
    return undefined
  }
}

async function readCredentials(root: string): Promise<Credentials | undefined> {
  if (!existsSync(root)) return undefined
  if ((await stat(root)).isFile()) return readCredentialFile(root)
  for (const name of (await readdir(root)).filter((name) => name.endsWith('.json')).sort()) {
    const credentials = await readCredentialFile(join(root, name))
    if (credentials) return credentials
  }
  return undefined
}

function credentialPath(root: string, username: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(username)) throw new Error(`Unsafe Threads username: ${username}`)
  return join(root, `${username}.json`)
}

async function saveCredentials(root: string, credentials: Credentials): Promise<void> {
  if (!credentials.username) throw new Error('Threads profile did not include a username')
  let legacyPath: string | undefined
  if (existsSync(root) && (await stat(root)).isFile()) {
    legacyPath = `${root}.${randomUUID()}.legacy`
    await rename(root, legacyPath)
  }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    await atomicWrite(credentialPath(root, credentials.username), `${JSON.stringify(credentials, null, 2)}\n`, 0o600)
    if (legacyPath) await rm(legacyPath, { force: true })
  } catch (error) {
    if (legacyPath) {
      await rm(root, { recursive: true, force: true })
      await rename(legacyPath, root)
    }
    throw error
  }
}

async function authorize(config: OAuthConfig, credentialsPath: string): Promise<Credentials> {
  const state = randomBytes(32).toString('hex')
  let cloudflared: ChildProcessWithoutNullStreams | undefined
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`)
    if (url.pathname !== callbackPath) {
      response.writeHead(url.pathname === '/health' ? 200 : 404)
      response.end(url.pathname === '/health' ? 'ok' : 'Not found')
      return
    }
    const error = url.searchParams.get('error_description')
    const code = url.searchParams.get('code')
    if (error || !code || url.searchParams.get('state') !== state) {
      const message = error || (!code ? 'Missing OAuth code' : 'Invalid OAuth state')
      response.writeHead(400)
      response.end(message)
      if (error) rejectCode(new Error(message))
      return
    }
    response.end('Authorization received. Return to the terminal.')
    resolveCode(code)
  })

  const onSignal = (): void => rejectCode(new Error('Authorization cancelled'))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    await listen(server, config.port)
    let redirectUri: string
    if (config.redirectUri) {
      redirectUri = validateRedirectUri(config.redirectUri)
      if (!config.tunnelName) throw new Error('CLOUDFLARED_TUNNEL is required with THREADS_REDIRECT_URI')
      cloudflared = await ensureFixedTunnel(config.tunnelName, redirectUri, config.port)
    } else {
      const tunnel = await startQuickTunnel(config.port)
      cloudflared = tunnel.process
      redirectUri = tunnel.redirectUri
      await confirmRedirectUri(redirectUri)
    }

    console.log(`\nOpen this URL:\n${authUrl(config.appId, redirectUri, state)}\n`)
    const timeout = setTimeout(() => rejectCode(new Error('OAuth callback timed out after 10 minutes')), 600_000)
    const code = await codePromise.finally(() => clearTimeout(timeout))
    const shortToken = await exchangeCode(config.appId, config.appSecret, redirectUri, code)
    const longToken = await exchangeLongLivedToken(config.appSecret, shortToken.access_token)
    const profile = await fetchThreadsProfile(longToken.access_token)
    const credentials = credentialsFromToken(longToken, profile.id, profile.username)
    await saveCredentials(credentialsPath, credentials)
    log('INFO', 'oauth.authorize', `saved ${credentialPath(credentialsPath, profile.username)}`)
    return credentials
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await close(server)
    cloudflared?.kill('SIGTERM')
  }
}

/** Load, refresh, or interactively create Threads credentials. */
export async function getCredentials(config: OAuthConfig): Promise<Credentials> {
  const path = join(config.cwd, '.credentials')
  let credentials = await readCredentials(path)
  if (credentials && !credentials.username) {
    try {
      const profile = await fetchThreadsProfile(credentials.access_token)
      credentials = { ...credentials, user_id: profile.id, username: profile.username }
      await saveCredentials(path, credentials)
    } catch (error) {
      log('WARNING', 'oauth.getCredentials', `legacy credential lookup failed; starting OAuth (${error instanceof Error ? error.message : String(error)})`)
      credentials = undefined
    }
  }
  if (credentials && Date.parse(credentials.expires_at) - Date.now() > refreshBeforeMs) return credentials

  if (credentials && Date.parse(credentials.expires_at) > Date.now()) {
    try {
      const token = await refreshLongLivedToken(credentials.access_token)
      const refreshed = credentialsFromToken(token, credentials.user_id, credentials.username)
      await saveCredentials(path, refreshed)
      log('INFO', 'oauth.getCredentials', 'refreshed access token')
      return refreshed
    } catch (error) {
      log('WARNING', 'oauth.getCredentials', `token refresh failed; starting OAuth (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  return authorize(config, path)
}
