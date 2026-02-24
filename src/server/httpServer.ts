import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express, { type Express } from 'express'
import { createCodexBridgeMiddleware } from './codexAppServerBridge.js'
import { createAuthMiddleware } from './authMiddleware.js'
import { createPiCompatBridgeMiddleware } from './piCompatBridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')

export type ServerOptions = {
  password?: string
}

export type ServerInstance = {
  app: Express
  dispose: () => void
}

export function createServer(options: ServerOptions = {}): ServerInstance {
  const app = express()
  const bridge = createCodexBridgeMiddleware()
  const piBridge = createPiCompatBridgeMiddleware()

  // 1. Auth middleware (if password is set)
  if (options.password) {
    app.use(createAuthMiddleware(options.password))
  }

  // 2. Bridge middleware for /codex-api/*
  app.use(bridge)

  // 3. Pi compatibility middleware for /pi-api/*
  app.use(piBridge)

  // 4. Static files from Vue build
  app.use(express.static(distDir))

  // 5. SPA fallback
  app.use((_req, res) => {
    res.sendFile(join(distDir, 'index.html'))
  })

  return {
    app,
    dispose: () => {
      bridge.dispose()
      piBridge.dispose()
    },
  }
}
