import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

const prefixBin = process.env.PREFIX ? join(process.env.PREFIX, 'bin') : ''
const shellPath = prefixBin ? join(prefixBin, 'sh') : '/bin/sh'

type PendingRequest = {
  id: string
  command: string
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeout: NodeJS.Timeout
}

type PiResponseMessage = {
  id?: string
  type?: string
  command?: string
  success?: boolean
  data?: unknown
  error?: string
}

type PiEventMessage = Record<string, unknown> & {
  type?: string
  data?: unknown
}

export type PiRuntimeHealth = {
  status: 'starting' | 'running' | 'stopped' | 'errored'
  pid: number | null
  restartCount: number
  startedAtIso: string | null
  lastEventAtIso: string | null
  lastError: string | null
}

export type PiRuntimeNotification = {
  method: 'pi/event' | 'pi/status' | 'pi/error'
  params: unknown
  atIso: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }
  const record = asRecord(value)
  if (!record) return fallback
  if (typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error
  }
  return fallback
}

export class PiRpcProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private readBuffer = ''
  private readonly notifications = new EventEmitter()
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 1
  private restartTimer: NodeJS.Timeout | null = null
  private disposed = false
  private startPromise: Promise<void> | null = null
  private restartCount = 0
  private startedAtIso: string | null = null
  private lastEventAtIso: string | null = null
  private lastError: string | null = null
  private status: PiRuntimeHealth['status'] = 'stopped'

  private emitNotification(notification: PiRuntimeNotification): void {
    this.notifications.emit('notification', notification)
  }

  private setStatus(status: PiRuntimeHealth['status'], error: string | null = null): void {
    this.status = status
    if (error) {
      this.lastError = error
    }
    this.emitNotification({
      method: status === 'errored' ? 'pi/error' : 'pi/status',
      params: this.health(),
      atIso: new Date().toISOString(),
    })
  }

  private scheduleRestart(): void {
    if (this.disposed) return
    if (this.restartTimer) return

    const delayMs = Math.min(30000, 1000 * Math.max(1, this.restartCount))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.ensureStarted()
    }, delayMs)
    this.restartTimer.unref()
  }

  private failAllPending(reason: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  private handleResponseMessage(message: PiResponseMessage): void {
    const id = typeof message.id === 'string' ? message.id : ''
    if (!id) return
    const pending = this.pending.get(id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(id)

    if (message.success === false) {
      const errorMessage = typeof message.error === 'string' && message.error.trim().length > 0
        ? message.error
        : `Pi command ${pending.command} failed`
      pending.reject(new Error(errorMessage))
      return
    }

    pending.resolve(message.data ?? null)
  }

  private handleEventMessage(message: PiEventMessage): void {
    const eventType = typeof message.type === 'string' && message.type.length > 0
      ? message.type
      : 'unknown'
    const data = 'data' in message ? message.data ?? null : null
    this.lastEventAtIso = new Date().toISOString()
    this.emitNotification({
      method: 'pi/event',
      params: {
        eventType,
        data,
        raw: message,
      },
      atIso: this.lastEventAtIso,
    })
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.emitNotification({
        method: 'pi/error',
        params: {
          message: 'Malformed JSON line from Pi runtime',
          line,
        },
        atIso: new Date().toISOString(),
      })
      return
    }

    const message = asRecord(parsed)
    if (!message) return

    const type = typeof message.type === 'string' ? message.type : ''
    const id = typeof message.id === 'string' ? message.id : ''

    if (type === 'response' && id.length > 0) {
      this.handleResponseMessage(message as PiResponseMessage)
      return
    }

    this.handleEventMessage(message as PiEventMessage)
  }

  private startProcess(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Pi runtime has been disposed'))
    }
    if (this.process) {
      return Promise.resolve()
    }
    if (this.startPromise) {
      return this.startPromise
    }

    const startPromise = new Promise<void>((resolve, reject) => {
      this.setStatus('starting')

      const proc = spawn(shellPath, ['-c', 'exec pi --mode rpc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        this.readBuffer += chunk
        let lineEnd = this.readBuffer.indexOf('\n')
        while (lineEnd !== -1) {
          const line = this.readBuffer.slice(0, lineEnd).trim()
          this.readBuffer = this.readBuffer.slice(lineEnd + 1)
          if (line.length > 0) {
            this.handleStdoutLine(line)
          }
          lineEnd = this.readBuffer.indexOf('\n')
        }
      })

      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        const message = chunk.trim()
        if (!message) return
        this.lastError = message
        this.emitNotification({
          method: 'pi/error',
          params: {
            message,
            source: 'stderr',
          },
          atIso: new Date().toISOString(),
        })
      })

      proc.on('error', (error) => {
        const message = extractErrorMessage(error, 'Failed to start Pi runtime')
        settle(() => reject(new Error(message)))
      })

      proc.on('spawn', () => {
        this.process = proc
        this.restartCount += 1
        this.startedAtIso = new Date().toISOString()
        this.readBuffer = ''
        this.setStatus('running')
        settle(() => resolve())
      })

      proc.on('exit', (_code, signal) => {
        this.process = null
        this.readBuffer = ''
        const message = signal
          ? `Pi runtime stopped by signal ${signal}`
          : 'Pi runtime exited'
        if (!this.disposed) {
          this.lastError = message
        }
        this.failAllPending(new Error(message))
        if (this.disposed) {
          this.setStatus('stopped')
          return
        }
        this.setStatus('errored', message)
        this.scheduleRestart()
      })
    }).finally(() => {
      this.startPromise = null
    })

    this.startPromise = startPromise
    return startPromise
  }

  async ensureStarted(): Promise<void> {
    await this.startProcess()
  }

  async call(command: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<unknown> {
    await this.ensureStarted()

    const proc = this.process
    if (!proc) {
      throw new Error('Pi runtime is not running')
    }

    const id = `req-${String(this.requestCounter++)}`
    const payload: Record<string, unknown> = {
      id,
      type: command,
      ...params,
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi command "${command}" timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      timeout.unref()

      this.pending.set(id, {
        id,
        command,
        resolve,
        reject,
        timeout,
      })

      try {
        proc.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error(extractErrorMessage(error, `Failed to write Pi command "${command}"`)))
      }
    })
  }

  onNotification(listener: (notification: PiRuntimeNotification) => void): () => void {
    this.notifications.on('notification', listener)
    return () => {
      this.notifications.off('notification', listener)
    }
  }

  health(): PiRuntimeHealth {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      restartCount: this.restartCount,
      startedAtIso: this.startedAtIso,
      lastEventAtIso: this.lastEventAtIso,
      lastError: this.lastError,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.failAllPending(new Error('Pi runtime has been disposed'))

    const proc = this.process
    this.process = null
    this.readBuffer = ''
    this.setStatus('stopped')

    if (!proc) return
    try {
      proc.stdin.end()
    } catch {
      // ignore shutdown errors
    }
    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore shutdown errors
    }

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore shutdown errors
        }
      }
    }, 1500)
    forceKillTimer.unref()
  }
}
