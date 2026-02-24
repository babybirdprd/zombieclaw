import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const PAIRING_CODE_UPPER_BOUND = 1000000
const MAX_PAIR_ATTEMPTS = 5
const LOCKOUT_SECONDS = 300
const MAX_TRACKED_CLIENTS = 1024

type PersistedStore = {
  version: 1
  tokenHashes: string[]
}

type AttemptState = {
  count: number
  lockedAtMs: number | null
}

export type PairingStatus = {
  pairingRequired: boolean
  paired: boolean
  pairingCode: string | null
}

function defaultStorePath(): string {
  return join(homedir(), '.anyclaw', 'pi-bridge-auth.json')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function looksLikeHash(value: string): boolean {
  return value.length === 64 && /^[a-fA-F0-9]{64}$/u.test(value)
}

function generatePairingCode(): string {
  return String(Math.floor(Math.random() * PAIRING_CODE_UPPER_BOUND)).padStart(6, '0')
}

function generateBearerToken(): string {
  return `zc_${randomBytes(32).toString('hex')}`
}

export class PiPairingGuard {
  private readonly storePath: string
  private readonly requirePairing: boolean
  private pairingCode: string | null = null
  private readonly tokenHashes = new Set<string>()
  private readonly attempts = new Map<string, AttemptState>()
  private loadPromise: Promise<void> | null = null

  constructor(options: { storePath?: string; requirePairing?: boolean } = {}) {
    this.storePath = options.storePath ?? defaultStorePath()
    this.requirePairing = options.requirePairing ?? true
  }

  private async persist(): Promise<void> {
    const payload: PersistedStore = {
      version: 1,
      tokenHashes: Array.from(this.tokenHashes),
    }
    await mkdir(dirname(this.storePath), { recursive: true })
    await writeFile(this.storePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  private async load(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      try {
        const raw = await readFile(this.storePath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return
        }
        const tokenHashes = (parsed as { tokenHashes?: unknown }).tokenHashes
        if (!Array.isArray(tokenHashes)) return
        for (const token of tokenHashes) {
          if (typeof token !== 'string' || token.length === 0) continue
          const normalized = looksLikeHash(token) ? token.toLowerCase() : hashToken(token)
          this.tokenHashes.add(normalized)
        }
      } catch {
        // Missing file is expected on first launch.
      }
      if (this.requirePairing && this.tokenHashes.size === 0) {
        this.pairingCode = generatePairingCode()
      }
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private normalizeClientKey(clientKey: string): string {
    const normalized = clientKey.trim()
    return normalized.length > 0 ? normalized : 'unknown'
  }

  private clearExpiredAttempts(nowMs: number): void {
    for (const [key, value] of this.attempts.entries()) {
      if (!value.lockedAtMs) continue
      if (nowMs - value.lockedAtMs >= LOCKOUT_SECONDS * 1000) {
        this.attempts.delete(key)
      }
    }

    if (this.attempts.size <= MAX_TRACKED_CLIENTS) return
    const keys = Array.from(this.attempts.keys())
    for (const key of keys.slice(0, this.attempts.size - MAX_TRACKED_CLIENTS)) {
      this.attempts.delete(key)
    }
  }

  private getLockoutRemainingSeconds(clientKey: string): number {
    const record = this.attempts.get(clientKey)
    if (!record || !record.lockedAtMs) return 0
    const elapsedMs = Date.now() - record.lockedAtMs
    const remainingMs = LOCKOUT_SECONDS * 1000 - elapsedMs
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0
  }

  private markFailedAttempt(clientKey: string): void {
    const nowMs = Date.now()
    this.clearExpiredAttempts(nowMs)
    const record = this.attempts.get(clientKey) ?? { count: 0, lockedAtMs: null }

    if (record.lockedAtMs && nowMs - record.lockedAtMs >= LOCKOUT_SECONDS * 1000) {
      record.count = 0
      record.lockedAtMs = null
    }

    record.count += 1
    if (record.count >= MAX_PAIR_ATTEMPTS) {
      record.lockedAtMs = nowMs
    }

    this.attempts.set(clientKey, record)
  }

  async status(): Promise<PairingStatus> {
    await this.load()
    return {
      pairingRequired: this.requirePairing,
      paired: this.tokenHashes.size > 0,
      pairingCode: this.requirePairing ? this.pairingCode : null,
    }
  }

  async isAuthenticated(token: string): Promise<boolean> {
    await this.load()
    if (!this.requirePairing) return true
    const trimmed = token.trim()
    if (trimmed.length === 0) return false
    return this.tokenHashes.has(hashToken(trimmed))
  }

  async tryPair(inputCode: string, clientKey: string): Promise<
    | { ok: true; token: string }
    | { ok: false; reason: 'pairing_disabled' | 'already_paired' | 'invalid_code' | 'locked'; retryAfterSeconds?: number }
  > {
    await this.load()
    if (!this.requirePairing) {
      return { ok: false, reason: 'pairing_disabled' }
    }

    const normalizedClientKey = this.normalizeClientKey(clientKey)
    const remainingLockout = this.getLockoutRemainingSeconds(normalizedClientKey)
    if (remainingLockout > 0) {
      return { ok: false, reason: 'locked', retryAfterSeconds: remainingLockout }
    }

    if (!this.pairingCode) {
      return { ok: false, reason: 'already_paired' }
    }

    const candidate = inputCode.trim()
    if (candidate !== this.pairingCode) {
      this.markFailedAttempt(normalizedClientKey)
      const retryAfterSeconds = this.getLockoutRemainingSeconds(normalizedClientKey)
      if (retryAfterSeconds > 0) {
        return { ok: false, reason: 'locked', retryAfterSeconds }
      }
      return { ok: false, reason: 'invalid_code' }
    }

    this.attempts.delete(normalizedClientKey)
    const token = generateBearerToken()
    this.tokenHashes.add(hashToken(token))
    this.pairingCode = null
    await this.persist()
    return { ok: true, token }
  }

  async resetPairingCodeForTestingOnly(): Promise<void> {
    await this.load()
    if (this.tokenHashes.size === 0) {
      this.pairingCode = generatePairingCode()
    }
  }
}
