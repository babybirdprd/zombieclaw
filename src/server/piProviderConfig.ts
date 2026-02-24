import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type PiProviderModelConfig = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export type PiProviderConfig = {
  api?: string
  baseUrl?: string
  apiKey?: string
  authHeader?: boolean
  headers?: Record<string, string>
  models?: PiProviderModelConfig[]
}

export type PiModelsConfig = {
  providers: Record<string, PiProviderConfig>
}

export type PiProviderPreset = {
  id: string
  name: string
  description: string
  providerId: string
  api: string
  baseUrl: string
  modelId: string
  apiKeyEnv: string
}

export type PiProviderConfigInput = {
  providerId: string
  api?: string
  baseUrl?: string
  apiKey?: string
  modelId?: string
  modelName?: string
  contextWindow?: number
  maxTokens?: number
  authHeader?: boolean
  headers?: Record<string, string>
}

export type PiProviderConfigView = {
  providerId: string
  api: string | null
  baseUrl: string | null
  apiKeyMasked: string | null
  authHeader: boolean | null
  models: string[]
}

const modelsConfigPath = join(homedir(), '.pi', 'agent', 'models.json')

const providerPresets: PiProviderPreset[] = [
  {
    id: 'nvidia',
    name: 'NVIDIA',
    description: 'Native NVIDIA endpoint via pi_agent_rust preset routing',
    providerId: 'nvidia',
    api: 'openai-completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelId: 'meta/llama-3.1-70b-instruct',
    apiKeyEnv: 'NVIDIA_API_KEY',
  },
  {
    id: 'modal-glm5',
    name: 'Modal GLM-5',
    description: 'Modal-hosted GLM-5 (OpenAI-compatible). Edit model/base URL if your workspace differs.',
    providerId: 'modal',
    api: 'openai-completions',
    baseUrl: 'https://api.us-west-2.modal.direct/v1',
    modelId: 'zai-org/GLM-5-FP8',
    apiKeyEnv: 'MODAL_API_KEY',
  },
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function defaultModelsConfig(): PiModelsConfig {
  return { providers: {} }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined
  if (!Number.isFinite(value)) return undefined
  if (value <= 0) return undefined
  return Math.floor(value)
}

function maskSecret(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length <= 8) {
    return '********'
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

export function getPiModelsConfigPath(): string {
  return modelsConfigPath
}

export function getPiProviderPresets(): PiProviderPreset[] {
  return providerPresets.slice()
}

export async function loadPiModelsConfig(): Promise<PiModelsConfig> {
  try {
    const raw = await readFile(modelsConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    if (!record) return defaultModelsConfig()

    const providersRecord = asRecord(record.providers)
    if (!providersRecord) return defaultModelsConfig()

    const providers: Record<string, PiProviderConfig> = {}
    for (const [providerIdRaw, providerValue] of Object.entries(providersRecord)) {
      const providerRecord = asRecord(providerValue)
      if (!providerRecord) continue
      const providerId = providerIdRaw.trim().toLowerCase()
      if (!providerId) continue

      let models: PiProviderModelConfig[] | undefined
      if (Array.isArray(providerRecord.models)) {
        const parsedModels: PiProviderModelConfig[] = []
        for (const entry of providerRecord.models) {
          const row = asRecord(entry)
          if (!row) continue
          const modelId = normalizeOptionalString(row.id)
          if (!modelId) continue

          const parsedModel: PiProviderModelConfig = { id: modelId }
          const modelName = normalizeOptionalString(row.name)
          if (modelName) parsedModel.name = modelName
          const contextWindow = normalizeOptionalNumber(row.contextWindow)
          if (contextWindow) parsedModel.contextWindow = contextWindow
          const maxTokens = normalizeOptionalNumber(row.maxTokens)
          if (maxTokens) parsedModel.maxTokens = maxTokens
          parsedModels.push(parsedModel)
        }
        models = parsedModels
      }

      const headersRecord = asRecord(providerRecord.headers)
      const headers = headersRecord
        ? Object.fromEntries(
            Object.entries(headersRecord).filter((entry): entry is [string, string] =>
              typeof entry[0] === 'string' && typeof entry[1] === 'string',
            ),
          )
        : undefined

      providers[providerId] = {
        api: normalizeOptionalString(providerRecord.api),
        baseUrl: normalizeOptionalString(providerRecord.baseUrl),
        apiKey: normalizeOptionalString(providerRecord.apiKey),
        authHeader: typeof providerRecord.authHeader === 'boolean' ? providerRecord.authHeader : undefined,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
        models: models && models.length > 0 ? models : undefined,
      }
    }

    return { providers }
  } catch {
    return defaultModelsConfig()
  }
}

export async function savePiModelsConfig(config: PiModelsConfig): Promise<void> {
  await mkdir(dirname(modelsConfigPath), { recursive: true })
  await writeFile(modelsConfigPath, JSON.stringify(config, null, 2), 'utf8')
}

export function upsertPiProviderConfig(config: PiModelsConfig, input: PiProviderConfigInput): PiModelsConfig {
  const providerId = input.providerId.trim().toLowerCase()
  if (!providerId) {
    throw new Error('providerId is required')
  }

  const existing = config.providers[providerId] ?? {}
  const nextProvider: PiProviderConfig = {
    ...existing,
  }

  const api = normalizeOptionalString(input.api)
  if (api) nextProvider.api = api

  const baseUrl = normalizeOptionalString(input.baseUrl)
  if (baseUrl) nextProvider.baseUrl = baseUrl

  const apiKey = normalizeOptionalString(input.apiKey)
  if (apiKey) nextProvider.apiKey = apiKey

  if (typeof input.authHeader === 'boolean') {
    nextProvider.authHeader = input.authHeader
  }

  if (input.headers && typeof input.headers === 'object') {
    const headers = Object.fromEntries(
      Object.entries(input.headers)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key, value]) => key.length > 0 && value.length > 0),
    )
    if (Object.keys(headers).length > 0) {
      nextProvider.headers = headers
    }
  }

  const modelId = normalizeOptionalString(input.modelId)
  if (modelId) {
    const modelEntry: PiProviderModelConfig = {
      id: modelId,
      name: normalizeOptionalString(input.modelName),
      contextWindow: normalizeOptionalNumber(input.contextWindow),
      maxTokens: normalizeOptionalNumber(input.maxTokens),
    }
    nextProvider.models = [modelEntry]
  }

  config.providers[providerId] = nextProvider
  return config
}

export function listPiProviderConfigs(config: PiModelsConfig): PiProviderConfigView[] {
  return Object.entries(config.providers)
    .map(([providerId, provider]) => ({
      providerId,
      api: provider.api ?? null,
      baseUrl: provider.baseUrl ?? null,
      apiKeyMasked: maskSecret(provider.apiKey),
      authHeader: typeof provider.authHeader === 'boolean' ? provider.authHeader : null,
      models: Array.isArray(provider.models)
        ? provider.models
            .map((model) => model.id.trim())
            .filter((modelId) => modelId.length > 0)
        : [],
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId))
}
