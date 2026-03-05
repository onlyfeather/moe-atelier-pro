import type { AppConfig } from '../types/app'
import type { CollectionItem } from '../types/collection'
import type { GlobalStats } from '../types/stats'
import type { PersistedImageTaskState } from '../types/imageTask'
import type { ApiFormat } from './apiUrl'
import type { FormatConfig } from '../app/storage'

export interface BackendState {
  config: AppConfig
  configByFormat?: Partial<Record<ApiFormat, FormatConfig>>
  tasksOrder: string[]
  globalStats: GlobalStats
}

const backendFetch = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
  })
  if (response.status === 401) {
    const error = new Error('BACKEND_UNAUTHORIZED')
    ;(error as Error & { code?: string }).code = 'BACKEND_UNAUTHORIZED'
    throw error
  }
  return response
}

type BackendJsonOptions = Omit<RequestInit, 'body' | 'headers'> & {
  body?: unknown
  headers?: HeadersInit
}

const backendJson = async <T>(
  path: string,
  options: BackendJsonOptions = {},
): Promise<T> => {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  const response = await backendFetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || response.statusText)
  }
  return (await response.json()) as T
}

const stripApiConfigFields = (config: any) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  const {
    apiKey,
    apiUrl,
    apiFormat,
    apiVersion,
    vertexProjectId,
    vertexLocation,
    vertexPublisher,
    ...rest
  } = config
  return rest
}

const stripApiFieldsFromState = (payload: Partial<BackendState>) => {
  if (!payload || typeof payload !== 'object') return payload
  const next: Partial<BackendState> = { ...payload }
  if (next.config) {
    next.config = stripApiConfigFields(next.config) as BackendState['config']
  }
  if (next.configByFormat && typeof next.configByFormat === 'object') {
    const updated: BackendState['configByFormat'] = { ...next.configByFormat }
    Object.keys(updated).forEach((key) => {
      const value = (updated as any)[key]
      ;(updated as any)[key] = stripApiConfigFields(value)
    })
    next.configByFormat = updated
  }
  return next
}

export const fetchBackendState = async () => backendJson<BackendState>('/api/backend/state')

export const patchBackendState = async (payload: Partial<BackendState>) =>
  backendJson<BackendState>('/api/backend/state', {
    method: 'PATCH',
    body: stripApiFieldsFromState(payload),
  })

export const fetchBackendCollection = async () =>
  backendJson<CollectionItem[]>('/api/backend/collection')

export const putBackendCollection = async (items: CollectionItem[]) =>
  backendJson<CollectionItem[]>('/api/backend/collection', {
    method: 'PUT',
    body: items,
  })

export const fetchBackendTask = async (taskId: string) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`)

export const putBackendTask = async (taskId: string, state: PersistedImageTaskState) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: state,
  })

export const patchBackendTask = async (
  taskId: string,
  payload: Partial<PersistedImageTaskState>,
) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: payload,
  })

export const deleteBackendTask = async (taskId: string) =>
  backendJson<{ ok: true }>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })

export const deleteBackendImage = async (key: string) =>
  backendJson<{ ok: true }>(`/api/backend/image/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })

export const cleanupBackendImages = async (keys: string[]) =>
  backendJson<{ ok: true }>('/api/backend/images/cleanup', {
    method: 'POST',
    body: { keys },
  })

export const generateBackendTask = async (taskId: string) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/generate`,
    { method: 'POST' },
  )

export const retryBackendSubTask = async (taskId: string, subTaskId: string) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/retry`,
    { method: 'POST', body: { subTaskId } },
  )

export type BackendStopMode = 'pause' | 'abort'

export const stopBackendSubTask = async (
  taskId: string,
  subTaskId?: string,
  mode: BackendStopMode = 'pause',
) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/stop`,
    { method: 'POST', body: { subTaskId, mode } },
  )

export const uploadBackendImage = async (
  blob: Blob,
  meta: { name?: string; lastModified?: number } = {},
) => {
  const headers: HeadersInit = {
    'Content-Type': blob.type || 'application/octet-stream',
  }
  if (typeof meta.lastModified === 'number') {
    headers['X-Upload-Last-Modified'] = String(meta.lastModified)
  }
  const response = await backendFetch('/api/backend/upload', {
    method: 'POST',
    headers,
    body: blob,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || response.statusText)
  }
  return (await response.json()) as { key: string; url: string }
}

export const buildBackendImageUrl = (key: string) =>
  `/api/backend/image/${encodeURIComponent(key)}`

export const buildBackendStreamUrl = () => '/api/backend/stream'

export const fetchBackendModels = async (
  payload: Partial<AppConfig> & { ignoreWhitelist?: boolean },
) =>
  backendJson<{ label: string; value: string }[]>('/api/backend/models', {
    method: 'POST',
    body: payload,
  })

export const stripBackendToken = (url: string) =>
  url.replace(/[?&]token=[^&]+/g, '').replace(/[?&]$/, '')
