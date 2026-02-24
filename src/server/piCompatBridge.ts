import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { PiPairingGuard } from './piPairing.js'
import { PiRpcProcess, type PiRuntimeNotification } from './piRpcProcess.js'

const prefixBin = process.env.PREFIX ? join(process.env.PREFIX, 'bin') : ''
const shellPath = prefixBin ? join(prefixBin, 'sh') : '/bin/sh'

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

export function createPiCompatBridgeMiddleware(): PiCompatBridgeMiddleware {
  const runtime = new PiRpcProcess()
  const pairing = new PiPairingGuard({
    requirePairing: process.env.PI_BRIDGE_REQUIRE_PAIRING !== '0',
  })
  const connections = new Set<ServerResponse>()
  const eventUnsubscribeByConnection = new Map<ServerResponse, () => void>()
  const closeByConnection = new Map<ServerResponse, () => void>()

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

    if (req.method === 'POST' && url.pathname === '/pi-api/pair') {
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

    if (req.method === 'GET' && url.pathname === '/pi-api/events') {
      const auth = await requireAuth(req, url)
      if (!auth.ok) {
        setJson(res, auth.statusCode, { error: auth.error })
        return
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      connections.add(res)

      const sendStatus = async () => {
        if (res.writableEnded || res.destroyed) return
        const payload = await readPiCompatStatus(runtime, pairing)
        res.write(`data: ${JSON.stringify({ method: 'pi/status', params: payload, atIso: new Date().toISOString() })}\n\n`)
      }

      try {
        await runtime.ensureStarted()
      } catch (error) {
        res.write(`data: ${JSON.stringify({
          method: 'pi/error',
          params: { message: getErrorMessage(error, 'Failed to start Pi runtime') },
          atIso: new Date().toISOString(),
        })}\n\n`)
        res.end()
        return
      }
      await sendStatus()

      const unsubscribe = runtime.onNotification((notification: PiRuntimeNotification) => {
        if (res.writableEnded || res.destroyed) return
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
    ])

    if (needsAuthPaths.has(url.pathname)) {
      const auth = await requireAuth(req, url)
      if (!auth.ok) {
        setJson(res, auth.statusCode, { error: auth.error })
        return
      }
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
