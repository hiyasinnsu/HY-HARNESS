import fs from 'node:fs'
import path from 'node:path'

export function ensureStateDirs(stateDir: string): void {
  for (const sub of ['', 'spill', 'jobs', 'ckpt', 'temp']) {
    fs.mkdirSync(path.join(stateDir, sub), { recursive: true })
  }
}

export function sessionLogPath(stateDir: string): string {
  return path.join(stateDir, 'session.v1.jsonl')
}
