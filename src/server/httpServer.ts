import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express, { type Express } from 'express'
import { createCodexBridgeMiddleware } from './codexAppServerBridge.js'
import { createAuthMiddleware } from './authMiddleware.js'
import { createPiCompatBridgeMiddleware } from './piCompatBridge.js'
import { createZeroClawWsBridge } from './zeroclawWsBridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const codexDistDir = join(__dirname, '..', 'dist')
const zeroclawDistDir = join(__dirname, '..', 'dist-zeroclaw')

export type ServerOptions = {
  password?: string
}

export type ServerInstance = {
  app: Express
  dispose: () => void
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
}

export function createServer(options: ServerOptions = {}): ServerInstance {
  const app = express()
  const bridge = createCodexBridgeMiddleware()
  const piBridge = createPiCompatBridgeMiddleware()
  const wsBridge = createZeroClawWsBridge()

  if (options.password) {
    app.use(createAuthMiddleware(options.password))
  }

  app.use(bridge)
  app.use(piBridge)
  app.get('/', (_req, res) => {
    res.redirect('/apps/zeroclaw')
  })

  app.use('/apps/codex', express.static(codexDistDir))
  app.use('/apps/zeroclaw', express.static(zeroclawDistDir))

  app.get(/^\/apps\/codex(?:\/.*)?$/, (_req, res) => {
    res.sendFile(join(codexDistDir, 'index.html'))
  })

  app.get(/^\/apps\/zeroclaw(?:\/.*)?$/, (_req, res) => {
    res.sendFile(join(zeroclawDistDir, 'index.html'))
  })

  app.use((_req, res) => {
    res.redirect('/apps/zeroclaw')
  })

  return {
    app,
    dispose: () => {
      bridge.dispose()
      piBridge.dispose()
      wsBridge.dispose()
    },
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      wsBridge.handleUpgrade(req, socket, head),
  }
}
