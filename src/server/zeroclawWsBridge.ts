import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { PiPairingGuard } from './piPairing.js'
import { PiRpcProcess } from './piRpcProcess.js'
import { shouldRequirePiPairing } from './pairingConfig.js'

type WsPayload = {
  type?: string
  content?: string
  message?: string
}

export type ZeroClawWsBridge = {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  dispose: () => void
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
  return fallback
}

function parsePayload(raw: RawData): WsPayload | null {
  try {
    const parsed = JSON.parse(raw.toString()) as unknown
    const record = asRecord(parsed)
    if (!record) return null
    return {
      type: typeof record.type === 'string' ? record.type : undefined,
      content: typeof record.content === 'string' ? record.content : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
    }
  } catch {
    return null
  }
}

function normalizeResultText(result: unknown): string {
  if (typeof result === 'string') return result
  const record = asRecord(result)
  if (!record) return JSON.stringify(result)
  const keys = ['message', 'output', 'text', 'response', 'content']
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }
  return JSON.stringify(result)
}

export function createZeroClawWsBridge(): ZeroClawWsBridge {
  const wss = new WebSocketServer({ noServer: true })
  const pairing = new PiPairingGuard({
    requirePairing: shouldRequirePiPairing(),
  })
  const runtime = new PiRpcProcess()

  wss.on('connection', (socket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const token = url.searchParams.get('token')?.trim() ?? ''
    let authenticated = false

    void (async () => {
      const status = await pairing.status()
      if (!status.pairingRequired) {
        authenticated = true
        return
      }
      const ok = await pairing.isAuthenticated(token)
      if (!ok) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Unauthorized websocket session. Pair first.',
        }))
        socket.close(4001, 'Unauthorized')
        return
      }
      authenticated = true
    })()

    socket.on('message', (raw: RawData) => {
      const payload = parsePayload(raw)
      if (!payload) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid websocket payload',
        }))
        return
      }

      const content = payload.content?.trim() ?? payload.message?.trim() ?? ''
      if (!content) return
      if (!authenticated) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Authentication pending',
        }))
        return
      }

      void (async () => {
        try {
          socket.send(JSON.stringify({ type: 'chunk', content: '' }))
          const result = await runtime.call('prompt', { message: content })
          socket.send(JSON.stringify({
            type: 'done',
            full_response: normalizeResultText(result),
          }))
        } catch (error) {
          socket.send(JSON.stringify({
            type: 'error',
            message: getErrorMessage(error, 'Runtime prompt failed'),
          }))
        }
      })()
    })
  })

  return {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
      if (!req.url) return false
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname !== '/ws/chat') {
        return false
      }

      wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
        wss.emit('connection', client, req)
      })
      return true
    },
    dispose: () => {
      for (const client of wss.clients) {
        try {
          client.close(1001, 'Server shutdown')
        } catch {
          // ignore close failures during shutdown
        }
      }
      wss.close()
      runtime.dispose()
    },
  }
}
