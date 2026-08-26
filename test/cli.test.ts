import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function runCli(cwd: string, setup = ''): Promise<{ code: number | null, stdout: string, stderr: string }> {
  const source = new URL('../src/cli.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `${setup}\nawait import(${JSON.stringify(source)})`], {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1', THREADS_APP_ID: 'app', THREADS_APP_SECRET: 'secret' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  return new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })))
}

test('CLI without an account requires saved credentials', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-cli-'))
  try {
    const result = await runCli(cwd)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Run threads-backup --account <username> first/)
  } finally {
    await rm(cwd, { recursive: true })
  }
})

test('CLI continues to later accounts after one account fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'threads-cli-'))
  const root = join(cwd, '.credentials')
  await mkdir(root)
  for (const account of ['bad', 'good']) {
    await writeFile(join(root, `${account}.json`), JSON.stringify({
      access_token: `${account}-token`,
      token_type: 'bearer',
      user_id: `${account}-id`,
      username: account,
      obtained_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    }))
  }
  try {
    const result = await runCli(cwd, `globalThis.fetch = async (_input, init) => init?.headers?.authorization === 'Bearer bad-token' ? new Response('nope', { status: 503 }) : Response.json({ data: [] })`)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /bad: Threads API failed \(503\): nope/)
    assert.match(result.stdout, /Start process good posts\./)
    assert.match(result.stdout, /good: Saved 0 posts with 0 failures/)
  } finally {
    await rm(cwd, { recursive: true })
  }
})
