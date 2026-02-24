import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createConnection } from 'node:net'
import { PiPairingGuard } from './piPairing.js'
import { PiRpcProcess, type PiRuntimeNotification } from './piRpcProcess.js'
import { shouldRequirePiPairing } from './pairingConfig.js'

const prefixBin = process.env.PREFIX ? join(process.env.PREFIX, 'bin') : ''
const shellPath = prefixBin ? join(prefixBin, 'sh') : '/bin/sh'
const compatStatePath = join(homedir(), '.zombieclaw', 'zeroclaw-compat-state.json')
const compatModelId = 'pi/default'

type CompatCronJob = {
  id: string
  name: string | null
  command: string
  schedule: string
  next_run: string
  last_run: string | null
  last_status: string | null
  enabled: boolean
}

type CompatMemoryEntry = {
  id: string
  key: string
  content: string
  category: string
  timestamp: string
  session_id: string | null
  score: number | null
}

type CompatCostSummary = {
  session_cost_usd: number
  daily_cost_usd: number
  monthly_cost_usd: number
  total_tokens: number
  request_count: number
  by_model: Record<string, {
    model: string
    cost_usd: number
    total_tokens: number
    request_count: number
  }>
}

type CompatState = {
  version: 1
  configToml: string
  cronJobs: CompatCronJob[]
  memoryEntries: CompatMemoryEntry[]
  cost: CompatCostSummary
}

function defaultCompatState(): CompatState {
  return {
    version: 1,
    configToml: [
      '# ZombieClaw compatibility config',
      '[runtime]',
      'provider = "pi_agent_rust"',
      `model = "${compatModelId}"`,
      '[gateway]',
      'host = "127.0.0.1"',
      'port = 18789',
      '',
    ].join('\n'),
    cronJobs: [],
    memoryEntries: [],
    cost: {
      session_cost_usd: 0,
      daily_cost_usd: 0,
      monthly_cost_usd: 0,
      total_tokens: 0,
      request_count: 0,
      by_model: {
        [compatModelId]: {
          model: compatModelId,
          cost_usd: 0,
          total_tokens: 0,
          request_count: 0,
        },
      },
    },
  }
}

type PiCompatStatus = {
  mode: 'pi_agent_rust_core'
  piCoreInstalled: boolean
  zeroClawCompatInstalled: boolean
  runtime: {
    status: 'starting' | 'running' | 'stopped' | 'errored'
    pid: number | null
    restartCount: number
    startedAtIso: string | null
    lastEventAtIso: string | null
    lastError: string | null
  }
  auth: {
    pairingRequired: boolean
    paired: boolean
    pairingCode: string | null
  }
  gateway: {
    url: string
    port: number
    reachable: boolean
  }
  dashboard: {
    url: string
    port: number
    reachable: boolean
  }
  checkedAtIso: string
}

type PiCompatBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }
  const record = asRecord(value)
  if (!record) return fallback
  const message = record.message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message
  }
  const error = record.error
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  const nested = asRecord(error)
  if (nested && typeof nested.message === 'string' && nested.message.trim().length > 0) {
    return nested.message
  }
  return fallback
}

async function commandSucceeds(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(shellPath, ['-c', command], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    proc.on('exit', (code) => {
      resolve(code === 0)
    })
    proc.on('error', () => {
      resolve(false)
    })
  })
}

async function commandOutput(command: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(shellPath, ['-c', command], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let output = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    proc.on('exit', () => {
      resolve(output.trim())
    })
    proc.on('error', () => {
      resolve('')
    })
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) return null
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return null

  return JSON.parse(raw) as unknown
}

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

async function loadCompatState(): Promise<CompatState> {
  try {
    const raw = await readFile(compatStatePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    if (!record) return defaultCompatState()

    const fallback = defaultCompatState()
    const cronJobs = Array.isArray(record.cronJobs)
      ? record.cronJobs.filter((value): value is CompatCronJob => {
        const row = asRecord(value)
        return Boolean(row && typeof row.id === 'string' && typeof row.command === 'string')
      })
      : fallback.cronJobs
    const memoryEntries = Array.isArray(record.memoryEntries)
      ? record.memoryEntries.filter((value): value is CompatMemoryEntry => {
        const row = asRecord(value)
        return Boolean(row && typeof row.id === 'string' && typeof row.key === 'string')
      })
      : fallback.memoryEntries
    const costRecord = asRecord(record.cost)
    const cost = costRecord
      ? {
        session_cost_usd: Number(costRecord.session_cost_usd ?? 0),
        daily_cost_usd: Number(costRecord.daily_cost_usd ?? 0),
        monthly_cost_usd: Number(costRecord.monthly_cost_usd ?? 0),
        total_tokens: Number(costRecord.total_tokens ?? 0),
        request_count: Number(costRecord.request_count ?? 0),
        by_model: asRecord(costRecord.by_model) as CompatCostSummary['by_model'] ?? fallback.cost.by_model,
      }
      : fallback.cost

    return {
      version: 1,
      configToml: typeof record.configToml === 'string' ? record.configToml : fallback.configToml,
      cronJobs,
      memoryEntries,
      cost,
    }
  } catch {
    return defaultCompatState()
  }
}

async function saveCompatState(state: CompatState): Promise<void> {
  await mkdir(dirname(compatStatePath), { recursive: true })
  await writeFile(compatStatePath, JSON.stringify(state, null, 2), 'utf8')
}

async function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
    timeout.unref()

    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })

    socket.once('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

function clientKeyFromRequest(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim()
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0]
  }
  const socketAddress = req.socket.remoteAddress ?? ''
  return socketAddress.trim().length > 0 ? socketAddress : 'unknown'
}

function extractBearerToken(req: IncomingMessage, url: URL): string {
  const authHeader = req.headers.authorization
  const tokenFromHeader = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : ''
  if (tokenFromHeader.length > 0) {
    return tokenFromHeader
  }
  return url.searchParams.get('token')?.trim() ?? ''
}

async function readPiCompatStatus(runtime: PiRpcProcess, pairing: PiPairingGuard): Promise<PiCompatStatus> {
  const [piCoreInstalled, zeroClawCompatInstalled] = await Promise.all([
    commandSucceeds('command -v pi >/dev/null 2>&1'),
    commandSucceeds('command -v zeroclaw >/dev/null 2>&1'),
  ])
  const [gatewayReachable, dashboardReachable, auth] = await Promise.all([
    isPortReachable(18789),
    isPortReachable(19001),
    pairing.status(),
  ])

  return {
    mode: 'pi_agent_rust_core',
    piCoreInstalled,
    zeroClawCompatInstalled,
    runtime: runtime.health(),
    auth,
    gateway: {
      url: 'ws://localhost:18789',
      port: 18789,
      reachable: gatewayReachable,
    },
    dashboard: {
      url: 'http://localhost:19001',
      port: 19001,
      reachable: dashboardReachable,
    },
    checkedAtIso: new Date().toISOString(),
  }
}

function getUptimeSeconds(startedAtIso: string | null): number {
  if (!startedAtIso) return 0
  const ms = Date.parse(startedAtIso)
  if (Number.isNaN(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

function buildCompatHealthSnapshot(status: PiCompatStatus) {
  const nowIso = new Date().toISOString()
  return {
    pid: status.runtime.pid ?? 0,
    updated_at: nowIso,
    uptime_seconds: getUptimeSeconds(status.runtime.startedAtIso),
    components: {
      runtime: {
        status: status.runtime.status === 'running' ? 'ok' : status.runtime.status,
        updated_at: nowIso,
        last_ok: status.runtime.status === 'running' ? nowIso : null,
        last_error: status.runtime.lastError,
        restart_count: status.runtime.restartCount,
      },
      gateway: {
        status: status.gateway.reachable ? 'ok' : 'degraded',
        updated_at: nowIso,
        last_ok: status.gateway.reachable ? nowIso : null,
        last_error: status.gateway.reachable ? null : 'Gateway not reachable',
        restart_count: 0,
      },
      auth: {
        status: status.auth.paired ? 'ok' : 'warn',
        updated_at: nowIso,
        last_ok: status.auth.paired ? nowIso : null,
        last_error: status.auth.paired ? null : 'Not paired',
        restart_count: 0,
      },
    },
  }
}

function buildCompatStatusPayload(status: PiCompatStatus) {
  const health = buildCompatHealthSnapshot(status)
  return {
    provider: 'pi_agent_rust',
    model: compatModelId,
    temperature: 0.2,
    uptime_seconds: health.uptime_seconds,
    gateway_port: status.gateway.port,
    locale: 'en',
    memory_backend: 'sqlite',
    paired: status.auth.paired,
    channels: {
      webhook: true,
      mobile: true,
      rpc: true,
    },
    health,
  }
}

function resultAsText(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }
  const record = asRecord(result)
  if (!record) return JSON.stringify(result)
  const candidateKeys = ['message', 'output', 'text', 'response', 'content']
  for (const key of candidateKeys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }
  return JSON.stringify(result)
}

function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const words = trimmed.split(/\s+/u).length
  return Math.max(1, Math.round(words * 1.3))
}

export function createPiCompatBridgeMiddleware(): PiCompatBridgeMiddleware {
  const runtime = new PiRpcProcess()
  const pairing = new PiPairingGuard({
    requirePairing: shouldRequirePiPairing(),
  })
  const connections = new Set<ServerResponse>()
  const eventUnsubscribeByConnection = new Map<ServerResponse, () => void>()
  const closeByConnection = new Map<ServerResponse, () => void>()
  let compatStatePromise: Promise<CompatState> | null = null

  const readCompatState = async (): Promise<CompatState> => {
    if (!compatStatePromise) {
      compatStatePromise = loadCompatState().then((state) => state)
    }
    return compatStatePromise
  }

  const mutateCompatState = async (mutator: (state: CompatState) => void): Promise<CompatState> => {
    const state = await readCompatState()
    mutator(state)
    await saveCompatState(state)
    return state
  }

  const recordPromptCost = async (input: string, output: string): Promise<void> => {
    const tokenCount = estimateTokens(input) + estimateTokens(output)
    const costUsd = tokenCount * 0.0000018
    await mutateCompatState((state) => {
      const current = state.cost.by_model[compatModelId] ?? {
        model: compatModelId,
        cost_usd: 0,
        total_tokens: 0,
        request_count: 0,
      }
      current.total_tokens += tokenCount
      current.request_count += 1
      current.cost_usd += costUsd
      state.cost.by_model[compatModelId] = current
      state.cost.total_tokens += tokenCount
      state.cost.request_count += 1
      state.cost.session_cost_usd += costUsd
      state.cost.daily_cost_usd += costUsd
      state.cost.monthly_cost_usd += costUsd
    })
  }

  const callPiCommand = async (command: string, params?: Record<string, unknown>) => {
    const payload = params ?? {}
    return runtime.call(command, payload)
  }

  const requireAuth = async (req: IncomingMessage, url: URL): Promise<{
    ok: true
    token: string
  } | {
    ok: false
    statusCode: number
    error: string
  }> => {
    const authStatus = await pairing.status()
    if (!authStatus.pairingRequired) {
      return { ok: true, token: '' }
    }

    const token = extractBearerToken(req, url)
    const valid = await pairing.isAuthenticated(token)
    if (valid) {
      return { ok: true, token }
    }

    return {
      ok: false,
      statusCode: 401,
      error: 'Unauthorized — pair first via POST /pi-api/pair, then send Authorization: Bearer <token>',
    }
  }

  const closeStreamConnection = (res: ServerResponse, keepAlive: NodeJS.Timeout, statusTicker: NodeJS.Timeout) => {
    clearInterval(keepAlive)
    clearInterval(statusTicker)
    const unsubscribe = eventUnsubscribeByConnection.get(res)
    if (unsubscribe) {
      unsubscribe()
      eventUnsubscribeByConnection.delete(res)
    }
    closeByConnection.delete(res)
    connections.delete(res)
    if (!res.writableEnded) {
      res.end()
    }
  }

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url) {
      next()
      return
    }

    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/pi-api/health') {
      const status = await readPiCompatStatus(runtime, pairing)
      setJson(res, 200, { data: status })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const status = await readPiCompatStatus(runtime, pairing)
      setJson(res, 200, { health: buildCompatHealthSnapshot(status) })
      return
    }

    if (req.method === 'POST' && (url.pathname === '/pi-api/pair' || url.pathname === '/pair')) {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        setJson(res, 400, { error: getErrorMessage(error, 'Invalid JSON body') })
        return
      }

      const bodyRecord = asRecord(body)
      const codeFromBody = typeof bodyRecord?.code === 'string' ? bodyRecord.code : ''
      const codeFromHeader = typeof req.headers['x-pairing-code'] === 'string'
        ? req.headers['x-pairing-code']
        : ''
      const code = codeFromBody.trim().length > 0 ? codeFromBody.trim() : codeFromHeader.trim()

      if (code.length === 0) {
        setJson(res, 400, { error: 'Missing pairing code. Pass `code` in JSON body or X-Pairing-Code header.' })
        return
      }

      const pairResult = await pairing.tryPair(code, clientKeyFromRequest(req))
      if (!pairResult.ok) {
        if (pairResult.reason === 'locked') {
          if (typeof pairResult.retryAfterSeconds === 'number') {
            res.setHeader('Retry-After', String(pairResult.retryAfterSeconds))
          }
          setJson(res, 423, {
            error: `Too many invalid attempts. Retry in ${String(pairResult.retryAfterSeconds ?? 0)} seconds.`,
          })
          return
        }
        if (pairResult.reason === 'invalid_code') {
          setJson(res, 401, { error: 'Invalid pairing code.' })
          return
        }
        if (pairResult.reason === 'already_paired') {
          setJson(res, 409, { error: 'Runtime already paired. Reset token storage to pair again.' })
          return
        }
        setJson(res, 409, { error: 'Pairing is disabled.' })
        return
      }

      if (url.pathname === '/pair') {
        setJson(res, 200, { token: pairResult.token })
        return
      }

      setJson(res, 200, {
        data: {
          token: pairResult.token,
          tokenType: 'Bearer',
          message: 'Save this token and pass it as Authorization: Bearer <token> for /pi-api requests.',
        },
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/pi-api/auth/status') {
      const status = await pairing.status()
      setJson(res, 200, { data: status })
      return
    }

    if (req.method === 'GET' && (url.pathname === '/pi-api/events' || url.pathname === '/api/events')) {
      const auth = await requireAuth(req, url)
      if (!auth.ok) {
        setJson(res, auth.statusCode, { error: auth.error })
        return
      }
      const zeroApiShape = url.pathname === '/api/events'

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      connections.add(res)

      const sendStatus = async () => {
        if (res.writableEnded || res.destroyed) return
        const payload = await readPiCompatStatus(runtime, pairing)
        if (zeroApiShape) {
          res.write(`data: ${JSON.stringify({
            type: 'status',
            timestamp: new Date().toISOString(),
            data: buildCompatStatusPayload(payload),
          })}\n\n`)
          return
        }
        res.write(`data: ${JSON.stringify({ method: 'pi/status', params: payload, atIso: new Date().toISOString() })}\n\n`)
      }

      try {
        await runtime.ensureStarted()
      } catch (error) {
        res.write(`data: ${JSON.stringify({
          type: zeroApiShape ? 'error' : 'pi/error',
          message: getErrorMessage(error, 'Failed to start Pi runtime'),
          timestamp: new Date().toISOString(),
        })}\n\n`)
        res.end()
        return
      }
      await sendStatus()

      const unsubscribe = runtime.onNotification((notification: PiRuntimeNotification) => {
        if (res.writableEnded || res.destroyed) return
        if (zeroApiShape) {
          const record = asRecord(notification.params)
          const type = notification.method === 'pi/error'
            ? 'error'
            : notification.method === 'pi/status'
              ? 'status'
              : (typeof record?.eventType === 'string' ? record.eventType : 'event')
          const payload = {
            type,
            timestamp: notification.atIso,
            data: record?.data ?? notification.params,
            message: typeof record?.message === 'string' ? record.message : undefined,
          }
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          return
        }
        res.write(`data: ${JSON.stringify(notification)}\n\n`)
      })
      eventUnsubscribeByConnection.set(res, unsubscribe)

      const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(': ping\n\n')
        }
      }, 15000)

      const statusTicker = setInterval(() => {
        void sendStatus()
      }, 8000)

      const close = () => closeStreamConnection(res, keepAlive, statusTicker)
      closeByConnection.set(res, close)

      req.on('close', close)
      req.on('aborted', close)
      return
    }

    const needsAuthPaths = new Set([
      '/pi-api/state',
      '/pi-api/messages',
      '/pi-api/models',
      '/pi-api/model',
      '/pi-api/prompt',
      '/pi-api/abort',
      '/pi-api/session/new',
      '/pi-api/session/switch',
      '/pi-api/session/name',
      '/pi-api/rpc',
      '/pi-api/webhook',
      '/api/status',
      '/api/config',
      '/api/tools',
      '/api/cron',
      '/api/integrations',
      '/api/doctor',
      '/api/memory',
      '/api/cost',
      '/api/cli-tools',
      '/api/events',
    ])

    const needsAuth =
      needsAuthPaths.has(url.pathname)
      || url.pathname.startsWith('/api/cron/')
      || url.pathname.startsWith('/api/memory/')

    if (needsAuth) {
      const auth = await requireAuth(req, url)
      if (!auth.ok) {
        setJson(res, auth.statusCode, { error: auth.error })
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const status = await readPiCompatStatus(runtime, pairing)
      setJson(res, 200, buildCompatStatusPayload(status))
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const state = await readCompatState()
      setJson(res, 200, {
        format: 'toml',
        content: state.configToml,
      })
      return
    }

    if (req.method === 'PUT' && url.pathname === '/api/config') {
      const content = await readTextBody(req)
      await mutateCompatState((state) => {
        state.configToml = content.trim().length > 0 ? content : defaultCompatState().configToml
      })
      setJson(res, 200, { status: 'ok' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/tools') {
      setJson(res, 200, {
        tools: [
          {
            name: 'prompt',
            description: 'Send a prompt to pi_agent_rust runtime',
            parameters: {
              type: 'object',
              properties: {
                message: { type: 'string' },
              },
              required: ['message'],
            },
          },
          {
            name: 'abort',
            description: 'Abort active runtime generation',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'set_model',
            description: 'Switch runtime provider/model',
            parameters: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                modelId: { type: 'string' },
              },
              required: ['provider', 'modelId'],
            },
          },
        ],
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/cron') {
      const state = await readCompatState()
      setJson(res, 200, { jobs: state.cronJobs })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/cron') {
      const body = await readJsonBody(req)
      const payload = asRecord(body)
      const schedule = typeof payload?.schedule === 'string' ? payload.schedule.trim() : ''
      const command = typeof payload?.command === 'string' ? payload.command.trim() : ''
      const name = typeof payload?.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : null
      if (!schedule || !command) {
        setJson(res, 400, { error: 'schedule and command are required' })
        return
      }
      const job: CompatCronJob = {
        id: randomUUID(),
        name,
        command,
        schedule,
        next_run: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        last_run: null,
        last_status: null,
        enabled: payload?.enabled !== false,
      }
      await mutateCompatState((state) => {
        state.cronJobs.push(job)
      })
      setJson(res, 200, { status: 'ok', job })
      return
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/cron/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/cron/', '').trim())
      await mutateCompatState((state) => {
        state.cronJobs = state.cronJobs.filter((job) => job.id !== id)
      })
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/integrations') {
      setJson(res, 200, {
        integrations: [
          {
            name: 'mobile',
            description: 'Android WebView embedding',
            category: 'platform',
            status: 'Active',
          },
          {
            name: 'gateway',
            description: 'ZeroClaw-compatible gateway and pairing',
            category: 'runtime',
            status: 'Active',
          },
          {
            name: 'webhook',
            description: 'Webhook compatibility endpoint',
            category: 'channel',
            status: 'Available',
          },
        ],
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/doctor') {
      const status = await readPiCompatStatus(runtime, pairing)
      setJson(res, 200, {
        results: [
          {
            severity: status.piCoreInstalled ? 'ok' : 'error',
            category: 'runtime',
            message: status.piCoreInstalled ? 'pi core detected' : 'pi core missing',
          },
          {
            severity: status.zeroClawCompatInstalled ? 'ok' : 'warn',
            category: 'compat',
            message: status.zeroClawCompatInstalled ? 'zeroclaw detected' : 'zeroclaw binary missing',
          },
          {
            severity: status.gateway.reachable ? 'ok' : 'warn',
            category: 'gateway',
            message: status.gateway.reachable ? 'gateway is reachable' : 'gateway is unreachable',
          },
          {
            severity: status.auth.paired ? 'ok' : 'warn',
            category: 'auth',
            message: status.auth.paired ? 'device is paired' : 'pairing still required',
          },
        ],
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
      const category = (url.searchParams.get('category') ?? '').trim().toLowerCase()
      const state = await readCompatState()
      const entries = state.memoryEntries.filter((entry) => {
        if (category.length > 0 && entry.category.toLowerCase() !== category) {
          return false
        }
        if (query.length === 0) return true
        return `${entry.key}\n${entry.content}`.toLowerCase().includes(query)
      })
      setJson(res, 200, { entries })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/memory') {
      const body = await readJsonBody(req)
      const payload = asRecord(body)
      const key = typeof payload?.key === 'string' ? payload.key.trim() : ''
      const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
      const category = typeof payload?.category === 'string' && payload.category.trim().length > 0
        ? payload.category.trim()
        : 'general'
      if (!key || !content) {
        setJson(res, 400, { error: 'key and content are required' })
        return
      }
      await mutateCompatState((state) => {
        const nextEntry: CompatMemoryEntry = {
          id: randomUUID(),
          key,
          content,
          category,
          timestamp: new Date().toISOString(),
          session_id: null,
          score: null,
        }
        const index = state.memoryEntries.findIndex((entry) => entry.key === key)
        if (index >= 0) {
          state.memoryEntries.splice(index, 1, nextEntry)
        } else {
          state.memoryEntries.unshift(nextEntry)
        }
      })
      setJson(res, 200, { status: 'ok' })
      return
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
      const key = decodeURIComponent(url.pathname.replace('/api/memory/', '').trim())
      await mutateCompatState((state) => {
        state.memoryEntries = state.memoryEntries.filter((entry) => entry.key !== key)
      })
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/cost') {
      const state = await readCompatState()
      setJson(res, 200, { cost: state.cost })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/cli-tools') {
      const [piPath, zeroclawPath, codexPath] = await Promise.all([
        commandOutput('command -v pi'),
        commandOutput('command -v zeroclaw'),
        commandOutput('command -v codex'),
      ])
      setJson(res, 200, {
        cli_tools: [
          { name: 'pi', path: piPath || '(missing)', version: null, category: 'runtime' },
          { name: 'zeroclaw', path: zeroclawPath || '(missing)', version: null, category: 'compat' },
          { name: 'codex', path: codexPath || '(missing)', version: null, category: 'assistant' },
        ],
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/pi-api/state') {
      try {
        const result = await callPiCommand('get_state')
        setJson(res, 200, { data: result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to read Pi state') })
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/pi-api/messages') {
      try {
        const result = await callPiCommand('get_messages')
        setJson(res, 200, { data: result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to read Pi messages') })
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/pi-api/models') {
      try {
        const result = await callPiCommand('get_available_models')
        setJson(res, 200, { data: result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to read Pi model list') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/model') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const provider = typeof payload?.provider === 'string' ? payload.provider.trim() : ''
        const modelId = typeof payload?.modelId === 'string' ? payload.modelId.trim() : ''
        if (!provider || !modelId) {
          setJson(res, 400, { error: 'Expected JSON body: { provider, modelId }' })
          return
        }
        const result = await callPiCommand('set_model', { provider, modelId })
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to update Pi model') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/prompt') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
        if (!message) {
          setJson(res, 400, { error: 'Expected JSON body: { message: string }' })
          return
        }
        const images = Array.isArray(payload?.images)
          ? payload.images.filter((value): value is string => typeof value === 'string')
          : undefined
        const streamingBehavior = typeof payload?.streamingBehavior === 'string'
          ? payload.streamingBehavior
          : undefined
        const result = await callPiCommand('prompt', {
          message,
          ...(images ? { images } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
        })
        await recordPromptCost(message, resultAsText(result))
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to send prompt to Pi runtime') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/abort') {
      try {
        const result = await callPiCommand('abort')
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to abort Pi generation') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/session/new') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const parentSession = typeof payload?.parentSession === 'string' ? payload.parentSession.trim() : ''
        const result = await callPiCommand('new_session', parentSession ? { parentSession } : {})
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to start new Pi session') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/session/switch') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const sessionPath = typeof payload?.sessionPath === 'string' ? payload.sessionPath.trim() : ''
        if (!sessionPath) {
          setJson(res, 400, { error: 'Expected JSON body: { sessionPath: string }' })
          return
        }
        const result = await callPiCommand('switch_session', { sessionPath })
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to switch Pi session') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/session/name') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
        if (!name) {
          setJson(res, 400, { error: 'Expected JSON body: { name: string }' })
          return
        }
        const result = await callPiCommand('set_session_name', { name })
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Failed to rename Pi session') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/webhook') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
        if (!message) {
          setJson(res, 400, { error: 'Expected JSON body: { message: string }' })
          return
        }
        const result = await callPiCommand('prompt', { message })
        await recordPromptCost(message, resultAsText(result))
        setJson(res, 200, { status: 'ok', result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Pi webhook compatibility call failed') })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/pi-api/rpc') {
      try {
        const body = await readJsonBody(req)
        const payload = asRecord(body)
        const method = typeof payload?.method === 'string' ? payload.method.trim() : ''
        if (!method) {
          setJson(res, 400, { error: 'Expected JSON body: { method, params? }' })
          return
        }
        const paramsRecord = asRecord(payload?.params) ?? {}
        const result = await callPiCommand(method, paramsRecord)
        setJson(res, 200, { result })
      } catch (error) {
        setJson(res, 502, { error: getErrorMessage(error, 'Pi RPC call failed') })
      }
      return
    }

    next()
  }

  middleware.dispose = () => {
    for (const close of closeByConnection.values()) {
      close()
    }
    connections.clear()
    closeByConnection.clear()
    eventUnsubscribeByConnection.clear()
    runtime.dispose()
  }

  return middleware
}
