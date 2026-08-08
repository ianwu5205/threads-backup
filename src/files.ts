import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { randomUUID } from 'node:crypto'

function temporaryPath(path: string): string {
  return `${path}.${randomUUID()}.tmp`
}

/** Atomically replace a file with new data. */
export async function atomicWrite(path: string, data: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = temporaryPath(path)
  try {
    await writeFile(temporary, data, { mode })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Atomically stream an HTTP response body into a file. */
export async function atomicDownload(path: string, response: Response): Promise<void> {
  if (!response.body) throw new Error(`Download returned no body: ${response.url}`)
  await mkdir(dirname(path), { recursive: true })
  const temporary = temporaryPath(path)
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), createWriteStream(temporary))
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
