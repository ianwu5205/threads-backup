#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { debuglog } from 'node:util'
import { backupPosts } from './backup.ts'
import { getCredentials } from './oauth.ts'

const debug = debuglog('threads-backup')

const help = `threads-backup - back up your Threads posts and media

Usage:
  threads-backup [--resume | --full-backup] [--backup-folder <path>]
  threads-backup --help
  threads-backup --version

Options:
  --resume       Skip completed posts and continue through all pages
  --full-backup  Re-fetch every post and media file
  --backup-folder <path>  Save backups in this folder (default: backups)
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
  const folderIndex = args.indexOf('--backup-folder')
  const backupFolder = folderIndex === -1 ? 'backups' : args[folderIndex + 1]
  if (!backupFolder || backupFolder.startsWith('-')) throw new Error('--backup-folder requires a path')
  const unknown = args.filter((argument, index) => !['--resume', '--full-backup', '--backup-folder'].includes(argument) && index !== folderIndex + 1)
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
  const summary = await backupPosts(cwd, credentials.access_token, args.includes('--full-backup'), args.includes('--resume'), backupFolder)
  const message = `Saved ${summary.saved} posts with ${summary.failed} failures.`
  console.log(message)
  if (summary.failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
