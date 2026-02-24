export type PiRuntimeNotification = {
  method: string
  params: unknown
  atIso: string
}

export type PiAuthStatus = {
  pairingRequired: boolean
  paired: boolean
  pairingCode: string | null
}

export type PiHealthResponse = {
  data?: {
    mode?: string
    piCoreInstalled?: boolean
    zeroClawCompatInstalled?: boolean
    runtime?: {
      status?: string
      pid?: number | null
      restartCount?: number
      startedAtIso?: string | null
      lastEventAtIso?: string | null
      lastError?: string | null
    }
    auth?: PiAuthStatus
    gateway?: {
      url?: string
      port?: number
      reachable?: boolean
    }
    dashboard?: {
      url?: string
      port?: number
      reachable?: boolean
    }
    checkedAtIso?: string
  }
  error?: string
}

function withAuthHeaders(token: string | null | undefined, headers: HeadersInit = {}): HeadersInit {
  const normalized = token?.trim() ?? ''
  if (!normalized) return headers
  return {
    ...headers,
    Authorization: `Bearer ${normalized}`,
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function extractError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error
    }
  }
  return fallback
}

async function getWithAuth<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(path, {
    headers: withAuthHeaders(token),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(extractError(payload, `${path} failed with HTTP ${String(response.status)}`))
  }
  return payload as T
}

async function postWithAuth<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: withAuthHeaders(token, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(body ?? {}),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(extractError(payload, `${path} failed with HTTP ${String(response.status)}`))
  }
  return payload as T
}

export async function fetchPiHealth(): Promise<PiHealthResponse> {
  return getWithAuth<PiHealthResponse>('/pi-api/health')
}

export async function fetchPiAuthStatus(token?: string): Promise<{ data?: PiAuthStatus; error?: string }> {
  return getWithAuth('/pi-api/auth/status', token)
}

export async function pairPiRuntime(code: string): Promise<{ data?: { token?: string }; error?: string }> {
  return postWithAuth('/pi-api/pair', { code })
}

export async function fetchPiState(token?: string): Promise<{ data?: unknown; error?: string }> {
  return getWithAuth('/pi-api/state', token)
}

export async function fetchPiMessages(token?: string): Promise<{ data?: unknown; error?: string }> {
  return getWithAuth('/pi-api/messages', token)
}

export async function fetchPiModels(token?: string): Promise<{ data?: unknown; error?: string }> {
  return getWithAuth('/pi-api/models', token)
}

export async function setPiModel(
  provider: string,
  modelId: string,
  token?: string,
): Promise<{ result?: unknown; error?: string }> {
  return postWithAuth('/pi-api/model', { provider, modelId }, token)
}

export async function promptPi(
  message: string,
  token?: string,
): Promise<{ result?: unknown; error?: string }> {
  return postWithAuth('/pi-api/prompt', { message }, token)
}

export async function abortPi(token?: string): Promise<{ result?: unknown; error?: string }> {
  return postWithAuth('/pi-api/abort', {}, token)
}

export function subscribePiNotifications(
  token: string | undefined,
  onNotification: (notification: PiRuntimeNotification) => void,
): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {}
  }

  const query = token && token.trim().length > 0
    ? `?token=${encodeURIComponent(token.trim())}`
    : ''
  const source = new EventSource(`/pi-api/events${query}`)

  source.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data) as unknown
      const value = parsed && typeof parsed === 'object'
        ? (parsed as PiRuntimeNotification)
        : null
      if (!value || typeof value.method !== 'string') return
      onNotification(value)
    } catch {
      // Ignore malformed event payloads and keep stream alive.
    }
  }

  return () => {
    source.close()
  }
}
