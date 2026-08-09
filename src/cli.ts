#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { backupPosts } from './backup.ts'
import { getCredentials } from './oauth.ts'

const help = `threads-backup - back up your Threads posts and media

Usage:
  threads-backup [--resume | --full-backup]
  threads-backup --help
  threads-backup --version

Options:
  --resume       Skip completed posts and continue through all pages
  --full-backup  Re-fetch every post and media file
  -h, --help     Show this help
  -v, --version  Show the version
`

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name} in .env`)
  return value
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help)
    return
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(packageVersion())
    return
  }
  const unknown = args.filter((argument) => !['--resume', '--full-backup'].includes(argument))
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`)
  if (args.includes('--resume') && args.includes('--full-backup')) throw new Error('--resume and --full-backup cannot be used together')

  const cwd = process.cwd()
  if (existsSync(`${cwd}/.env`)) loadEnvFile(`${cwd}/.env`)
  const port = Number(process.env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535')

  const credentials = await getCredentials({
    appId: requiredEnv('THREADS_APP_ID'),
    appSecret: requiredEnv('THREADS_APP_SECRET'),
    redirectUri: process.env.THREADS_REDIRECT_URI?.trim() || undefined,
    tunnelName: process.env.CLOUDFLARED_TUNNEL?.trim() || undefined,
    port,
    cwd,
  })
  const summary = await backupPosts(cwd, credentials.access_token, args.includes('--full-backup'), args.includes('--resume'))
  console.log(`${new Date()},INFO,cli.main,saved ${summary.saved} posts; ${summary.failed} failed.`)
  if (summary.failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(`${new Date()},ERROR,cli.main,${error instanceof Error ? error.message : String(error)}.`)
  process.exitCode = 1
})
