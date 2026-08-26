#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { backupPosts } from './backup.ts'
import { credentialAccounts, getCredentials } from './oauth.ts'

const help = `threads-backup - back up your Threads posts and media

Usage:
  threads-backup [-a <username>] [--resume | --full-backup] [--backup-folder <path>]
  threads-backup --help
  threads-backup --version

Options:
  -a, --account <username>  Back up one account (default: all saved accounts)
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
  const accountOptions = args.map((argument, index) => ['-a', '--account'].includes(argument) ? index : -1).filter((index) => index !== -1)
  if (accountOptions.length > 1) throw new Error('--account may only be specified once')
  const accountIndex = accountOptions[0] ?? -1
  const account = accountIndex === -1 ? undefined : args[accountIndex + 1]
  if (accountIndex !== -1 && (!account || account.startsWith('-'))) throw new Error('--account requires a username')
  if (account && (!/^[A-Za-z0-9._-]+$/.test(account) || account === '.' || account === '..')) throw new Error(`Unsafe Threads username: ${account}`)
  const values = new Set([folderIndex + 1, accountIndex + 1].filter((index) => index > 0))
  const unknown = args.filter((argument, index) => !['-a', '--account', '--resume', '--full-backup', '--backup-folder'].includes(argument) && !values.has(index))
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`)
  if (args.includes('--resume') && args.includes('--full-backup')) throw new Error('--resume and --full-backup cannot be used together')

  const cwd = process.cwd()
  if (existsSync(`${cwd}/.env`)) loadEnvFile(`${cwd}/.env`)
  const port = Number(process.env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535')

  const accounts = account ? [account] : await credentialAccounts(cwd)
  if (!accounts.length) throw new Error('No saved accounts. Run threads-backup --account <username> first.')
  const config = {
    appId: requiredEnv('THREADS_APP_ID'),
    appSecret: requiredEnv('THREADS_APP_SECRET'),
    redirectUri: process.env.THREADS_REDIRECT_URI?.trim() || undefined,
    tunnelName: process.env.CLOUDFLARED_TUNNEL?.trim() || undefined,
    port,
    cwd,
  }
  for (const selectedAccount of accounts) {
    console.log(`Start process ${selectedAccount} posts.`)
    try {
      const credentials = await getCredentials(config, selectedAccount)
      const summary = await backupPosts(cwd, credentials.access_token, selectedAccount, args.includes('--full-backup'), args.includes('--resume'), backupFolder)
      console.log(`${selectedAccount}: Saved ${summary.saved} posts with ${summary.failed} failures.`)
      if (summary.failed) process.exitCode = 1
    } catch (error) {
      console.error(`${selectedAccount}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
