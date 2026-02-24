<template>
  <DesktopLayout :is-sidebar-collapsed="isSidebarCollapsed">
    <template #sidebar>
      <section class="sidebar-root">
        <SidebarThreadControls
          v-if="!isSidebarCollapsed"
          class="sidebar-thread-controls-host"
          :is-sidebar-collapsed="isSidebarCollapsed"
          :is-auto-refresh-enabled="isAutoRefreshEnabled"
          :auto-refresh-button-label="autoRefreshButtonLabel"
          :show-new-thread-button="true"
          @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
          @toggle-auto-refresh="onToggleAutoRefreshTimer"
          @start-new-thread="onStartNewThreadFromToolbar"
        >
          <button
            class="sidebar-search-toggle"
            type="button"
            :aria-pressed="isSidebarSearchVisible"
            aria-label="Search threads"
            title="Search threads"
            @click="toggleSidebarSearch"
          >
            <IconTablerSearch class="sidebar-search-toggle-icon" />
          </button>
        </SidebarThreadControls>

        <div v-if="!isSidebarCollapsed && isSidebarSearchVisible" class="sidebar-search-bar">
          <IconTablerSearch class="sidebar-search-bar-icon" />
          <input
            ref="sidebarSearchInputRef"
            v-model="sidebarSearchQuery"
            class="sidebar-search-input"
            type="text"
            placeholder="Filter threads..."
            @keydown="onSidebarSearchKeydown"
          />
          <button
            v-if="sidebarSearchQuery.length > 0"
            class="sidebar-search-clear"
            type="button"
            aria-label="Clear search"
            @click="clearSidebarSearch"
          >
            <IconTablerX class="sidebar-search-clear-icon" />
          </button>
        </div>

        <SidebarThreadTree :groups="projectGroups" :project-display-name-by-id="projectDisplayNameById"
          v-if="!isSidebarCollapsed"
          :selected-thread-id="selectedThreadId" :is-loading="isLoadingThreads"
          :search-query="sidebarSearchQuery"
          @select="onSelectThread"
          @archive="onArchiveThread" @start-new-thread="onStartNewThread" @rename-project="onRenameProject"
          @remove-project="onRemoveProject" @reorder-project="onReorderProject" />

        <section v-if="!isSidebarCollapsed" class="app-drawer">
          <p class="app-drawer-title">App Drawer</p>
          <button
            type="button"
            class="app-drawer-item"
            :class="{ 'app-drawer-item--active': !isPiRoute }"
            @click="openCodexApp"
          >
            Codex
          </button>
          <button
            type="button"
            class="app-drawer-item"
            :class="{ 'app-drawer-item--active': isPiRoute }"
            @click="openPiApp"
          >
            ZombieClaw UI
          </button>
        </section>
      </section>
    </template>

    <template #content>
      <section class="content-root">
        <template v-if="isPiRoute">
          <section class="pi-app-shell">
            <header class="pi-app-header">
              <h1 class="pi-app-title">Pi Runtime Dashboard</h1>
              <button type="button" class="pi-switch-button" @click="openCodexApp">Back to Codex</button>
            </header>
            <p class="pi-app-status">{{ piStatusLabel }}</p>
            <section v-if="piRequiresPairing && !hasPiAuthToken" class="pi-pair-card">
              <p class="pi-pair-title">Pairing required</p>
              <p class="pi-pair-hint">
                Pairing code:
                <code>{{ piPairingCodeHint || 'unavailable' }}</code>
              </p>
              <div class="pi-pair-row">
                <input
                  v-model="piPairingCodeInput"
                  class="pi-input"
                  type="text"
                  placeholder="Enter pairing code"
                />
                <button type="button" class="pi-button" @click="onPairPiRuntime">Pair runtime</button>
              </div>
            </section>
            <section v-else class="pi-runtime-card">
              <div class="pi-runtime-actions">
                <button type="button" class="pi-button pi-button--secondary" @click="refreshPiHealth">Refresh</button>
                <button type="button" class="pi-button pi-button--secondary" @click="onAbortPiRuntime">Abort turn</button>
                <button type="button" class="pi-button pi-button--secondary" @click="onForgetPiToken">Forget token</button>
              </div>
              <div class="pi-runtime-row">
                <input
                  v-model="piPromptInput"
                  class="pi-input"
                  type="text"
                  placeholder="Send a prompt to pi runtime"
                  @keydown.enter.prevent="onSendPiPrompt"
                />
                <button type="button" class="pi-button" :disabled="piPromptBusy" @click="onSendPiPrompt">
                  {{ piPromptBusy ? 'Sending…' : 'Send prompt' }}
                </button>
              </div>
              <p class="pi-runtime-summary">{{ piRuntimeSummary }}</p>
              <pre v-if="piLastEventSummary" class="pi-event-log">{{ piLastEventSummary }}</pre>
            </section>
            <iframe class="pi-dashboard-frame" :src="piDashboardUrl" title="Pi Runtime Dashboard"></iframe>
          </section>
        </template>
        <template v-else>
          <ContentHeader :title="contentTitle">
            <template #leading>
              <SidebarThreadControls
                v-if="isSidebarCollapsed"
                class="sidebar-thread-controls-header-host"
                :is-sidebar-collapsed="isSidebarCollapsed"
                :is-auto-refresh-enabled="isAutoRefreshEnabled"
                :auto-refresh-button-label="autoRefreshButtonLabel"
                :show-new-thread-button="true"
                @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
                @toggle-auto-refresh="onToggleAutoRefreshTimer"
                @start-new-thread="onStartNewThreadFromToolbar"
              />
            </template>
          </ContentHeader>

          <section class="content-body">
            <template v-if="isHomeRoute">
              <div class="content-grid">
                <div class="new-thread-empty">
                  <p class="new-thread-hero">Let's build</p>
                  <ComposerDropdown class="new-thread-folder-dropdown" :model-value="newThreadCwd"
                    :options="newThreadFolderOptions" placeholder="Choose folder"
                    :disabled="newThreadFolderOptions.length === 0" @update:model-value="onSelectNewThreadFolder" />
                </div>

                <ThreadComposer :active-thread-id="composerThreadContextId" :disabled="isSendingMessage"
                  :models="availableModelIds" :selected-model="selectedModelId"
                  :selected-reasoning-effort="selectedReasoningEffort" :is-turn-in-progress="false"
                  :is-interrupting-turn="false" @submit="onSubmitThreadMessage"
                  @update:selected-model="onSelectModel" @update:selected-reasoning-effort="onSelectReasoningEffort" />
              </div>
            </template>
            <template v-else>
              <div class="content-grid">
                <div class="content-thread">
                  <ThreadConversation :messages="filteredMessages" :is-loading="isLoadingMessages"
                    :active-thread-id="composerThreadContextId" :scroll-state="selectedThreadScrollState"
                    :live-overlay="liveOverlay"
                    :pending-requests="selectedThreadServerRequests"
                    @update-scroll-state="onUpdateThreadScrollState"
                    @respond-server-request="onRespondServerRequest" />
                </div>

                <ThreadComposer :active-thread-id="composerThreadContextId"
                  :disabled="isSendingMessage || isLoadingMessages" :models="availableModelIds"
                  :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
                  :is-turn-in-progress="isSelectedThreadInProgress" :is-interrupting-turn="isInterruptingTurn"
                  @submit="onSubmitThreadMessage" @update:selected-model="onSelectModel"
                  @update:selected-reasoning-effort="onSelectReasoningEffort" @interrupt="onInterruptTurn" />
              </div>
            </template>
          </section>
        </template>
      </section>
    </template>
  </DesktopLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopLayout from './components/layout/DesktopLayout.vue'
import SidebarThreadTree from './components/sidebar/SidebarThreadTree.vue'
import ContentHeader from './components/content/ContentHeader.vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer from './components/content/ThreadComposer.vue'
import ComposerDropdown from './components/content/ComposerDropdown.vue'
import SidebarThreadControls from './components/sidebar/SidebarThreadControls.vue'
import IconTablerSearch from './components/icons/IconTablerSearch.vue'
import IconTablerX from './components/icons/IconTablerX.vue'
import { useDesktopState } from './composables/useDesktopState'
import {
  abortPi,
  fetchPiHealth,
  fetchPiState,
  pairPiRuntime,
  promptPi,
  subscribePiNotifications,
  type PiHealthResponse,
  type PiRuntimeNotification,
} from './api/piGateway'
import type { ReasoningEffort, ThreadScrollState } from './types/codex'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-web-local.sidebar-collapsed.v1'
const PI_AUTH_TOKEN_STORAGE_KEY = 'codex-web-local.pi-auth-token.v1'
const piDashboardUrl = computed(() => {
  return 'http://localhost:19001/?gatewayUrl=ws://localhost:18789'
})

const {
  projectGroups,
  projectDisplayNameById,
  selectedThread,
  selectedThreadScrollState,
  selectedThreadServerRequests,
  selectedLiveOverlay,
  selectedThreadId,
  availableModelIds,
  selectedModelId,
  selectedReasoningEffort,
  messages,
  isLoadingThreads,
  isLoadingMessages,
  isSendingMessage,
  isInterruptingTurn,
  isAutoRefreshEnabled,
  autoRefreshSecondsLeft,
  refreshAll,
  selectThread,
  setThreadScrollState,
  archiveThreadById,
  sendMessageToSelectedThread,
  sendMessageToNewThread,
  interruptSelectedThreadTurn,
  setSelectedModelId,
  setSelectedReasoningEffort,
  respondToPendingServerRequest,
  renameProject,
  removeProject,
  reorderProject,
  toggleAutoRefreshTimer,
  startPolling,
  stopPolling,
} = useDesktopState()

const route = useRoute()
const router = useRouter()
const isRouteSyncInProgress = ref(false)
const hasInitialized = ref(false)
const newThreadCwd = ref('')
const isSidebarCollapsed = ref(loadSidebarCollapsed())
const sidebarSearchQuery = ref('')
const isSidebarSearchVisible = ref(false)
const sidebarSearchInputRef = ref<HTMLInputElement | null>(null)
const piHealthSummary = ref('Connecting to Pi compatibility API…')
const piRuntimeSummary = ref('Runtime summary pending')
const piLastEventSummary = ref('')
const piPairingCodeHint = ref('')
const piPairingCodeInput = ref('')
const piPromptInput = ref('')
const piPromptBusy = ref(false)
const piAuthToken = ref(loadPiAuthToken())
const piRequiresPairing = ref(true)
let piHealthTimer: number | null = null
let piEventsUnsubscribe: (() => void) | null = null

const routeThreadId = computed(() => {
  const rawThreadId = route.params.threadId
  return typeof rawThreadId === 'string' ? rawThreadId : ''
})

const knownThreadIdSet = computed(() => {
  const ids = new Set<string>()
  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      ids.add(thread.id)
    }
  }
  return ids
})

const isHomeRoute = computed(() => route.name === 'home')
const isPiRoute = computed(() => route.name === 'app-pi')
const isCodexRoute = computed(() => route.name === 'home' || route.name === 'thread')
const contentTitle = computed(() => {
  if (isHomeRoute.value) return 'New thread'
  return selectedThread.value?.title ?? 'Choose a thread'
})
const piStatusLabel = computed(() => piHealthSummary.value)
const hasPiAuthToken = computed(() => piAuthToken.value.trim().length > 0)
const autoRefreshButtonLabel = computed(() =>
  isAutoRefreshEnabled.value
    ? `Auto refresh in ${String(autoRefreshSecondsLeft.value)}s`
    : 'Enable 4s refresh',
)
const filteredMessages = computed(() =>
  messages.value.filter((message) => {
    const type = normalizeMessageType(message.messageType, message.role)
    if (type === 'worked') return true
    if (type === 'turnActivity.live' || type === 'turnError.live' || type === 'agentReasoning.live') return false
    return true
  }),
)
const liveOverlay = computed(() => selectedLiveOverlay.value)
const composerThreadContextId = computed(() => (isHomeRoute.value ? '__new-thread__' : selectedThreadId.value))
const isSelectedThreadInProgress = computed(() => !isHomeRoute.value && selectedThread.value?.inProgress === true)
const DEFAULT_WORKSPACE_NAME = 'codex'

const newThreadFolderOptions = computed(() => {
  const options: Array<{ value: string; label: string }> = []
  const seenCwds = new Set<string>()

  for (const group of projectGroups.value) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd || seenCwds.has(cwd)) continue
    seenCwds.add(cwd)
    options.push({
      value: cwd,
      label: projectDisplayNameById.value[group.projectName] ?? group.projectName,
    })
  }

  if (options.length === 0) {
    options.push({ value: DEFAULT_WORKSPACE_NAME, label: DEFAULT_WORKSPACE_NAME })
  }

  return options
})

onMounted(() => {
  window.addEventListener('keydown', onWindowKeyDown)
  void initialize()
  void refreshPiHealth()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeyDown)
  stopPolling()
  clearPiHealthTimer()
  stopPiEventStream()
})

function toggleSidebarSearch(): void {
  isSidebarSearchVisible.value = !isSidebarSearchVisible.value
  if (isSidebarSearchVisible.value) {
    nextTick(() => sidebarSearchInputRef.value?.focus())
  } else {
    sidebarSearchQuery.value = ''
  }
}

function clearSidebarSearch(): void {
  sidebarSearchQuery.value = ''
  sidebarSearchInputRef.value?.focus()
}

function onSidebarSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    isSidebarSearchVisible.value = false
    sidebarSearchQuery.value = ''
  }
}

function openCodexApp(): void {
  if (isCodexRoute.value) return
  if (selectedThreadId.value) {
    void router.push({ name: 'thread', params: { threadId: selectedThreadId.value } })
    return
  }
  void router.push({ name: 'home' })
}

function openPiApp(): void {
  window.location.href = '/apps/zeroclaw'
}

function onSelectThread(threadId: string): void {
  if (!threadId) return
  if (route.name === 'thread' && routeThreadId.value === threadId) return
  void router.push({ name: 'thread', params: { threadId } })
}

function onArchiveThread(threadId: string): void {
  void archiveThreadById(threadId)
}

function onStartNewThread(projectName: string): void {
  const projectGroup = projectGroups.value.find((group) => group.projectName === projectName)
  const projectCwd = projectGroup?.threads[0]?.cwd?.trim() ?? ''
  if (projectCwd) {
    newThreadCwd.value = projectCwd
  }
  if (isHomeRoute.value) return
  void router.push({ name: 'home' })
}

function onStartNewThreadFromToolbar(): void {
  const cwd = selectedThread.value?.cwd?.trim() ?? ''
  if (cwd) {
    newThreadCwd.value = cwd
  }
  if (isHomeRoute.value) return
  void router.push({ name: 'home' })
}

function onRenameProject(payload: { projectName: string; displayName: string }): void {
  renameProject(payload.projectName, payload.displayName)
}

function onRemoveProject(projectName: string): void {
  removeProject(projectName)
}

function onReorderProject(payload: { projectName: string; toIndex: number }): void {
  reorderProject(payload.projectName, payload.toIndex)
}

function onUpdateThreadScrollState(payload: { threadId: string; state: ThreadScrollState }): void {
  setThreadScrollState(payload.threadId, payload.state)
}

function onRespondServerRequest(payload: { id: number; result?: unknown; error?: { code?: number; message: string } }): void {
  void respondToPendingServerRequest(payload)
}

function onToggleAutoRefreshTimer(): void {
  toggleAutoRefreshTimer()
}

function setSidebarCollapsed(nextValue: boolean): void {
  if (isSidebarCollapsed.value === nextValue) return
  isSidebarCollapsed.value = nextValue
  saveSidebarCollapsed(nextValue)
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (!event.ctrlKey && !event.metaKey) return
  if (event.shiftKey || event.altKey) return
  if (event.key.toLowerCase() !== 'b') return
  event.preventDefault()
  setSidebarCollapsed(!isSidebarCollapsed.value)
}

function onSubmitThreadMessage(text: string): void {
  if (isHomeRoute.value) {
    void submitFirstMessageForNewThread(text)
    return
  }
  void sendMessageToSelectedThread(text)
}

function onSelectNewThreadFolder(cwd: string): void {
  newThreadCwd.value = cwd.trim()
}

function onSelectModel(modelId: string): void {
  setSelectedModelId(modelId)
}

function onSelectReasoningEffort(effort: ReasoningEffort | ''): void {
  setSelectedReasoningEffort(effort)
}

function onInterruptTurn(): void {
  void interruptSelectedThreadTurn()
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
}

function saveSidebarCollapsed(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, value ? '1' : '0')
}

function loadPiAuthToken(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(PI_AUTH_TOKEN_STORAGE_KEY) ?? ''
}

function savePiAuthToken(value: string): void {
  if (typeof window === 'undefined') return
  const normalized = value.trim()
  if (!normalized) {
    window.localStorage.removeItem(PI_AUTH_TOKEN_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(PI_AUTH_TOKEN_STORAGE_KEY, normalized)
}

function summarizePiState(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Pi state unavailable'
  }

  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' && record.model.length > 0
    ? record.model
    : 'unknown model'
  const sessionPath = typeof record.sessionPath === 'string' && record.sessionPath.length > 0
    ? record.sessionPath
    : 'default session'
  const thinkingLevel = typeof record.thinkingLevel === 'string' && record.thinkingLevel.length > 0
    ? record.thinkingLevel
    : 'default'
  return `model: ${model} · thinking: ${thinkingLevel} · session: ${sessionPath}`
}

function stringifyLogValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    if (!serialized) return ''
    return serialized.length > 320 ? `${serialized.slice(0, 320)}…` : serialized
  } catch {
    return ''
  }
}

function getReadableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return fallback
}

function stopPiEventStream(): void {
  if (!piEventsUnsubscribe) return
  piEventsUnsubscribe()
  piEventsUnsubscribe = null
}

function onPiNotification(notification: PiRuntimeNotification): void {
  const time = new Date(notification.atIso).toLocaleTimeString()

  if (notification.method === 'pi/event') {
    const params = notification.params as Record<string, unknown> | null
    const eventType = typeof params?.eventType === 'string' && params.eventType.length > 0
      ? params.eventType
      : 'unknown'
    const dataSummary = stringifyLogValue(params?.data)
    piLastEventSummary.value = `[${time}] ${eventType}${dataSummary ? ` ${dataSummary}` : ''}`
    return
  }

  if (notification.method === 'pi/error') {
    const params = notification.params as Record<string, unknown> | null
    const message = typeof params?.message === 'string' ? params.message : 'Unknown Pi runtime error'
    piLastEventSummary.value = `[${time}] error ${message}`
    return
  }

  if (notification.method === 'pi/status') {
    const params = notification.params as PiHealthResponse['data'] | null
    if (params?.runtime?.status) {
      const pid = typeof params.runtime.pid === 'number' ? params.runtime.pid : null
      piRuntimeSummary.value = `runtime: ${params.runtime.status}${pid ? ` (pid ${String(pid)})` : ''}`
    }
  }
}

function startPiEventStream(): void {
  stopPiEventStream()
  if (piRequiresPairing.value && !hasPiAuthToken.value) return
  const token = hasPiAuthToken.value ? piAuthToken.value : undefined
  piEventsUnsubscribe = subscribePiNotifications(token, onPiNotification)
}

function normalizeMessageType(rawType: string | undefined, role: string): string {
  const normalized = (rawType ?? '').trim()
  if (normalized.length > 0) {
    return normalized
  }
  return role.trim() || 'message'
}

async function refreshPiStateSummary(): Promise<void> {
  if (!hasPiAuthToken.value) {
    piRuntimeSummary.value = 'Pair with Pi runtime to query state.'
    return
  }

  try {
    const payload = await fetchPiState(piAuthToken.value)
    piRuntimeSummary.value = summarizePiState(payload.data)
  } catch (error) {
    piRuntimeSummary.value = getReadableError(error, 'Failed to fetch Pi state')
  }
}

async function refreshPiHealth(): Promise<void> {
  try {
    const payload = await fetchPiHealth()
    const piInstalled = payload.data?.piCoreInstalled === true
    const compatInstalled = payload.data?.zeroClawCompatInstalled === true
    const runtimeStatus = payload.data?.runtime?.status ?? 'unknown'
    const gatewayReachable = payload.data?.gateway?.reachable === true
    const dashboardReachable = payload.data?.dashboard?.reachable === true
    const auth = payload.data?.auth
    piRequiresPairing.value = auth?.pairingRequired !== false
    piPairingCodeHint.value = auth?.pairingCode ?? ''
    const checkedAtIso = payload.data?.checkedAtIso ?? ''
    const checkedAt = checkedAtIso ? new Date(checkedAtIso).toLocaleTimeString() : 'just now'
    const status = [
      `pi core: ${piInstalled ? 'ready' : 'missing'}`,
      `zeroclaw compat: ${compatInstalled ? 'ready' : 'missing'}`,
      `runtime: ${runtimeStatus}`,
      `gateway: ${gatewayReachable ? 'up' : 'down'}`,
      `ui: ${dashboardReachable ? 'up' : 'down'}`,
      `checked: ${checkedAt}`,
    ]
    piHealthSummary.value = status.join(' · ')

    if (hasPiAuthToken.value) {
      void refreshPiStateSummary()
    } else if (piRequiresPairing.value) {
      piRuntimeSummary.value = 'Pairing required before Pi runtime commands are available.'
    }
  } catch {
    piHealthSummary.value = 'Pi API unavailable (network error)'
  }
}

function ensurePiHealthTimer(): void {
  if (piHealthTimer !== null) return
  if (typeof window === 'undefined') return
  piHealthTimer = window.setInterval(() => {
    void refreshPiHealth()
  }, 8000)
}

function clearPiHealthTimer(): void {
  if (piHealthTimer === null) return
  clearInterval(piHealthTimer)
  piHealthTimer = null
}

async function onPairPiRuntime(): Promise<void> {
  const code = piPairingCodeInput.value.trim()
  if (!code) {
    piRuntimeSummary.value = 'Enter the pairing code shown by the runtime.'
    return
  }

  try {
    const payload = await pairPiRuntime(code)
    const token = typeof payload.data?.token === 'string' ? payload.data.token.trim() : ''
    if (!token) {
      piRuntimeSummary.value = 'Pairing succeeded but token was missing in response.'
      return
    }
    piAuthToken.value = token
    savePiAuthToken(token)
    piPairingCodeInput.value = ''
    piRuntimeSummary.value = 'Paired successfully. Runtime token stored for this browser.'
    startPiEventStream()
    await refreshPiHealth()
  } catch (error) {
    piRuntimeSummary.value = getReadableError(error, 'Pairing failed')
  }
}

async function onSendPiPrompt(): Promise<void> {
  if (piPromptBusy.value) return
  const message = piPromptInput.value.trim()
  if (!message) return
  if (!hasPiAuthToken.value) {
    piRuntimeSummary.value = 'Pair before sending prompts.'
    return
  }

  piPromptBusy.value = true
  try {
    await promptPi(message, piAuthToken.value)
    piPromptInput.value = ''
    piRuntimeSummary.value = 'Prompt sent to Pi runtime.'
  } catch (error) {
    piRuntimeSummary.value = getReadableError(error, 'Failed to send Pi prompt')
  } finally {
    piPromptBusy.value = false
  }
}

async function onAbortPiRuntime(): Promise<void> {
  if (!hasPiAuthToken.value) return
  try {
    await abortPi(piAuthToken.value)
    piRuntimeSummary.value = 'Abort command sent.'
  } catch (error) {
    piRuntimeSummary.value = getReadableError(error, 'Failed to abort Pi runtime turn')
  }
}

function onForgetPiToken(): void {
  piAuthToken.value = ''
  savePiAuthToken('')
  stopPiEventStream()
  piRuntimeSummary.value = 'Pi token removed from browser storage.'
}

async function initialize(): Promise<void> {
  await refreshAll()
  hasInitialized.value = true
  await syncThreadSelectionWithRoute()
  startPolling()
}

async function syncThreadSelectionWithRoute(): Promise<void> {
  if (!isCodexRoute.value) return
  if (isRouteSyncInProgress.value) return
  isRouteSyncInProgress.value = true

  try {
    if (route.name === 'home') {
      if (selectedThreadId.value !== '') {
        await selectThread('')
      }
      return
    }

    if (route.name === 'thread') {
      const threadId = routeThreadId.value
      if (!threadId) return

      if (!knownThreadIdSet.value.has(threadId)) {
        await router.replace({ name: 'home' })
        return
      }

      if (selectedThreadId.value !== threadId) {
        await selectThread(threadId)
      }
      return
    }

  } finally {
    isRouteSyncInProgress.value = false
  }
}

watch(
  () =>
    [
      route.name,
      routeThreadId.value,
      isLoadingThreads.value,
      knownThreadIdSet.value.has(routeThreadId.value),
      selectedThreadId.value,
    ] as const,
  async () => {
    if (!hasInitialized.value) return
    await syncThreadSelectionWithRoute()
  },
)

watch(
  () => selectedThreadId.value,
  async (threadId) => {
    if (!hasInitialized.value) return
    if (isRouteSyncInProgress.value) return
    if (!isCodexRoute.value) return
    if (isHomeRoute.value) return

    if (!threadId) {
      if (route.name !== 'home') {
        await router.replace({ name: 'home' })
      }
      return
    }

    if (route.name === 'thread' && routeThreadId.value === threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  },
)

watch(
  () => isPiRoute.value,
  (active) => {
    if (active) {
      void refreshPiHealth()
      ensurePiHealthTimer()
      startPiEventStream()
      return
    }
    clearPiHealthTimer()
    stopPiEventStream()
  },
  { immediate: true },
)

watch(
  () => piAuthToken.value,
  () => {
    savePiAuthToken(piAuthToken.value)
    if (!isPiRoute.value) return
    startPiEventStream()
  },
)

watch(
  () => newThreadFolderOptions.value,
  (options) => {
    if (options.length === 0) {
      newThreadCwd.value = ''
      return
    }
    const hasSelected = options.some((option) => option.value === newThreadCwd.value)
    if (!hasSelected) {
      newThreadCwd.value = options[0].value
    }
  },
  { immediate: true },
)

async function submitFirstMessageForNewThread(text: string): Promise<void> {
  try {
    const threadId = await sendMessageToNewThread(text, newThreadCwd.value)
    if (!threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  } catch {
    // Error is already reflected in state.
  }
}
</script>

<style scoped>
@reference "tailwindcss";

.sidebar-root {
  @apply min-h-full py-4 px-2 flex flex-col gap-2 select-none;
}

.sidebar-root input,
.sidebar-root textarea {
  @apply select-text;
}

.content-root {
  @apply h-full min-h-0 w-full flex flex-col overflow-y-hidden overflow-x-visible bg-white;
}

.sidebar-thread-controls-host {
  @apply mt-1 -translate-y-px px-2 pb-1;
}

.sidebar-search-toggle {
  @apply h-6.75 w-6.75 rounded-md border border-transparent bg-transparent text-zinc-600 flex items-center justify-center transition hover:border-zinc-200 hover:bg-zinc-50;
}

.sidebar-search-toggle[aria-pressed='true'] {
  @apply border-zinc-300 bg-zinc-100 text-zinc-700;
}

.sidebar-search-toggle-icon {
  @apply w-4 h-4;
}

.sidebar-search-bar {
  @apply flex items-center gap-1.5 mx-2 px-2 py-1 rounded-md border border-zinc-200 bg-white transition-colors focus-within:border-zinc-400;
}

.sidebar-search-bar-icon {
  @apply w-3.5 h-3.5 text-zinc-400 shrink-0;
}

.sidebar-search-input {
  @apply flex-1 min-w-0 bg-transparent text-sm text-zinc-800 placeholder-zinc-400 outline-none border-none p-0;
}

.sidebar-search-clear {
  @apply w-4 h-4 rounded text-zinc-400 flex items-center justify-center transition hover:text-zinc-600;
}

.sidebar-search-clear-icon {
  @apply w-3.5 h-3.5;
}

.sidebar-thread-controls-header-host {
  @apply ml-1;
}

.content-body {
  @apply flex-1 min-h-0 w-full flex flex-col gap-3 pt-1 pb-4 overflow-y-hidden overflow-x-visible;
}

.content-error {
  @apply m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700;
}

.content-grid {
  @apply flex-1 min-h-0 flex flex-col gap-3;
}

.content-thread {
  @apply flex-1 min-h-0;
}

.new-thread-empty {
  @apply flex-1 min-h-0 flex flex-col items-center justify-center gap-0.5 px-6;
}

.new-thread-hero {
  @apply m-0 text-[2.5rem] font-normal leading-[1.05] text-zinc-900;
}

.new-thread-folder-dropdown {
  @apply text-[2.5rem] text-zinc-500;
}

.new-thread-folder-dropdown :deep(.composer-dropdown-trigger) {
  @apply h-auto text-[2.5rem] leading-[1.05];
}

.new-thread-folder-dropdown :deep(.composer-dropdown-value) {
  @apply leading-[1.05];
}

.new-thread-folder-dropdown :deep(.composer-dropdown-chevron) {
  @apply h-5 w-5 mt-0;
}

.app-drawer {
  @apply mt-auto mx-2 mb-1 flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2;
}

.app-drawer-title {
  @apply m-0 text-xs font-medium uppercase tracking-wide text-zinc-500;
}

.app-drawer-item {
  @apply rounded-md border border-transparent bg-white px-2.5 py-2 text-left text-sm text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-100;
}

.app-drawer-item--active {
  @apply border-zinc-300 bg-zinc-100 text-zinc-900 font-medium;
}

.pi-app-shell {
  @apply flex-1 min-h-0 flex flex-col gap-3 p-4;
}

.pi-app-header {
  @apply flex items-center gap-2;
}

.pi-app-title {
  @apply m-0 text-lg font-semibold text-zinc-900;
}

.pi-switch-button {
  @apply ml-auto rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100;
}

.pi-app-status {
  @apply m-0 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700;
}

.pi-pair-card,
.pi-runtime-card {
  @apply rounded-lg border border-zinc-200 bg-white p-3 flex flex-col gap-2;
}

.pi-pair-title {
  @apply m-0 text-sm font-semibold text-zinc-900;
}

.pi-pair-hint {
  @apply m-0 text-xs text-zinc-600;
}

.pi-pair-hint code {
  @apply rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700;
}

.pi-pair-row,
.pi-runtime-row {
  @apply flex items-center gap-2;
}

.pi-runtime-actions {
  @apply flex items-center gap-2 flex-wrap;
}

.pi-input {
  @apply h-9 flex-1 min-w-0 rounded-md border border-zinc-300 px-2 text-sm text-zinc-800 outline-none focus:border-zinc-500;
}

.pi-button {
  @apply h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60;
}

.pi-button--secondary {
  @apply border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100;
}

.pi-runtime-summary {
  @apply m-0 text-xs text-zinc-700;
}

.pi-event-log {
  @apply m-0 max-h-28 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-[11px] text-zinc-700;
}

.pi-dashboard-frame {
  @apply flex-1 min-h-[260px] w-full rounded-lg border border-zinc-200 bg-white;
}

</style>
