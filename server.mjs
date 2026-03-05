import express from 'express'
import session from 'express-session'
import connectSqlite3 from 'connect-sqlite3'
import svgCaptcha from 'svg-captcha'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  backendImagesDir,
  backendLogRequests,
  distDir,
  isProd,
  port,
  rootDir,
  dbPath,
  sessionSecret,
  sessionTtlSeconds,
  adminBootstrapUsername,
  adminBootstrapPassword,
  DEFAULT_BACKEND_CONFIG,
  DEFAULT_CONCURRENCY,
  DEFAULT_GLOBAL_STATS,
  DEFAULT_TASK_STATS,
  pickFormatConfig,
} from './server/config.mjs'
import { getDb, safeJsonParse } from './server/db.mjs'
import {
  cleanupExpiredCaptcha,
  createCaptcha,
  createUser,
  ensureBootstrapAdmin,
  getUserByUsername,
  listUsers,
  updateLastLogin,
  verifyCaptcha,
  verifyPassword,
} from './server/auth.mjs'
import {
  logBackendOutbound,
  logBackendRequest,
  logBackendResponse,
  describeFetchError,
} from './server/logger.mjs'
import { addSseClient, removeSseClient, sendSseEvent } from './server/sse.mjs'
import {
  createDefaultTaskState,
  loadBackendCollection,
  loadBackendState,
  loadTaskState,
  normalizeCollectionPayloadForSave,
  normalizeConcurrency,
  saveBackendCollection,
  saveBackendState,
  saveTaskState,
} from './server/storage.mjs'
import { parseMarkdownImage, resolveImageFromResponse } from './server/imageParser.mjs'
import {
  getBackendImagePath,
  getMimeFromFilename,
  saveBackendImageBuffer,
  saveImageBuffer,
} from './server/imageStore.mjs'

const readRequestBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const RETRY_DELAY_MS = 1000
const ORPHAN_CLEANUP_DELAY_MS = 1500

let orphanCleanupTimer = {}

const collectImageKeysFromTask = (taskState) => {
  const keys = new Set()
  const uploads = Array.isArray(taskState?.uploads) ? taskState.uploads : []
  const results = Array.isArray(taskState?.results) ? taskState.results : []
  uploads.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  results.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  return keys
}

const getRemovedImageKeys = (prevState, nextState) => {
  const prevKeys = collectImageKeysFromTask(prevState)
  const nextKeys = collectImageKeysFromTask(nextState)
  const removed = []
  for (const key of prevKeys) {
    if (!nextKeys.has(key)) removed.push(key)
  }
  return removed
}

const extractBackendImageKeyFromUrl = (value) => {
  if (typeof value !== 'string') return ''
  const match = value.match(/\/api\/backend\/image\/([^?]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const getCollectionImageKey = (item) => {
  const localKey = typeof item?.localKey === 'string' ? item.localKey : ''
  const imageKey = extractBackendImageKeyFromUrl(item?.image)
  const key = localKey || imageKey
  return key ? path.basename(String(key)) : ''
}

const collectImageKeysFromCollection = (items) => {
  const keys = new Set()
  if (!Array.isArray(items)) return keys
  items.forEach((item) => {
    const key = getCollectionImageKey(item)
    if (!key) return
    keys.add(key)
  })
  return keys
}

const listTaskIds = (userId) => {
  const db = getDb()
  return db
    .prepare('SELECT id FROM tasks WHERE user_id = ?')
    .all(userId)
    .map((row) => row.id)
}

const collectAllReferencedImageKeys = async (userId) => {
  const db = getDb()
  const keys = new Set()
  const uploads = db
    .prepare(
      `SELECT u.local_key
       FROM uploads u
       JOIN tasks t ON t.id = u.task_id
       WHERE t.user_id = ? AND u.local_key IS NOT NULL`,
    )
    .all(userId)
  uploads.forEach((row) => {
    if (row.local_key) keys.add(path.basename(String(row.local_key)))
  })
  const results = db
    .prepare(
      `SELECT r.local_key
       FROM task_results r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.user_id = ? AND r.local_key IS NOT NULL`,
    )
    .all(userId)
  results.forEach((row) => {
    if (row.local_key) keys.add(path.basename(String(row.local_key)))
  })
  const collections = db
    .prepare(
      `SELECT local_key FROM collections WHERE user_id = ? AND local_key IS NOT NULL`,
    )
    .all(userId)
  collections.forEach((row) => {
    if (row.local_key) keys.add(path.basename(String(row.local_key)))
  })
  return keys
}

const cleanupUnusedImages = async (userId, removedKeys = []) => {
  if (!removedKeys.length) return
  const referencedKeys = await collectAllReferencedImageKeys(userId)
  for (const key of removedKeys) {
    const safeKey = path.basename(String(key))
    if (!safeKey || referencedKeys.has(safeKey)) continue
    const filePath = getBackendImagePath(userId, safeKey)
    if (!filePath) continue
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const cleanupOrphanedImages = async (userId) => {
  const userDir = path.join(backendImagesDir, String(userId))
  let entries = []
  try {
    entries = await fs.promises.readdir(userDir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return
    throw err
  }
  const referencedKeys = await collectAllReferencedImageKeys(userId)
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (referencedKeys.has(entry.name)) continue
    const filePath = path.join(userDir, entry.name)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const scheduleOrphanCleanup = (userId) => {
  if (!userId) return
  if (orphanCleanupTimer?.[userId]) return
  if (!orphanCleanupTimer) {
    orphanCleanupTimer = {}
  }
  orphanCleanupTimer[userId] = setTimeout(() => {
    orphanCleanupTimer[userId] = null
    cleanupOrphanedImages(userId).catch((err) => {
      console.warn('清理后端图片缓存失败:', err)
    })
  }, ORPHAN_CLEANUP_DELAY_MS)
}

const buildResultCollectionKey = (subTaskId, endTime) =>
  `collection:result:${subTaskId}:${endTime}`

const buildUploadCollectionKey = (taskId, uploadKey) =>
  `collection:upload:${taskId}:${uploadKey}`

const buildUploadSignature = (upload) => {
  const name = typeof upload?.name === 'string' ? upload.name : ''
  const size = typeof upload?.size === 'number' ? upload.size : undefined
  const lastModified =
    typeof upload?.lastModified === 'number' ? upload.lastModified : undefined
  const type = typeof upload?.type === 'string' ? upload.type : ''
  if (!name || typeof size !== 'number' || typeof lastModified !== 'number') {
    return ''
  }
  return `${name}:${size}:${lastModified}:${type}`
}

const mergeCollectionItems = (existing, incoming) => {
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seen = new Set()
  const next = []
  incoming.forEach((item) => {
    if (!item?.id || seen.has(item.id)) return
    const merged = byId.has(item.id) ? { ...byId.get(item.id), ...item, id: item.id } : item
    next.push(merged)
    seen.add(item.id)
  })
  existing.forEach((item) => {
    if (!item?.id || seen.has(item.id)) return
    next.push(item)
    seen.add(item.id)
  })
  return next
}

let backendCollectionQueue = Promise.resolve()

const appendBackendCollectionItems = (userId, items) => {
  if (!Array.isArray(items) || items.length === 0) return
  backendCollectionQueue = backendCollectionQueue
    .then(async () => {
      const existing = await loadBackendCollection(userId)
      const next = mergeCollectionItems(existing, items)
      await saveBackendCollection(userId, next)
    })
    .catch((err) => {
      console.warn('后端收藏写入失败:', err)
    })
}

const parseDataUrl = (dataUrl = '') => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return null
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

const activeControllers = new Map()
const retryTimers = new Map()

const clearRetryTimer = (subTaskId) => {
  const timer = retryTimers.get(subTaskId)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(subTaskId)
  }
}

const abortActiveController = (subTaskId) => {
  const controller = activeControllers.get(subTaskId)
  if (controller) {
    controller.abort()
    activeControllers.delete(subTaskId)
  }
}

const updateStats = (stats, type, duration, count = 1) => {
  const next = { ...stats }
  if (type === 'request') {
    const increment =
      typeof count === 'number' && Number.isFinite(count)
        ? Math.max(0, Math.floor(count))
        : 1
    next.totalRequests += increment
  }
  if (type === 'success') {
    next.successCount += 1
    if (typeof duration === 'number') {
      next.totalTime += duration
      next.fastestTime = next.fastestTime === 0 ? duration : Math.min(next.fastestTime, duration)
      next.slowestTime = Math.max(next.slowestTime, duration)
    }
  }
  return next
}

const updateGlobalStats = async (userId, type, duration, count) => {
  const state = await loadBackendState(userId)
  const stats = updateStats(state.globalStats, type, duration, count)
  await saveBackendState(userId, { ...state, globalStats: stats })
}

const buildMessagesForTask = async (userId, taskState) => {
  const content = []
  if (taskState.prompt) {
    content.push({ type: 'text', text: taskState.prompt })
  }
  const uploads = Array.isArray(taskState.uploads) ? taskState.uploads : []
  for (const upload of uploads) {
    if (!upload?.localKey) continue
    const filePath = getBackendImagePath(userId, upload.localKey)
    if (!filePath) continue
    try {
      const buffer = await fs.promises.readFile(filePath)
      const mime = upload.type || getMimeFromFilename(upload.localKey)
      const base64 = buffer.toString('base64')
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}` },
      })
    } catch (err) {
      console.warn('读取上传图片失败:', err)
    }
  }
  return [{ role: 'user', content }]
}

const API_VERSION_REGEX = /^v1(?:beta1|beta)?$/i
const apiMarkerSegments = new Set(['projects', 'locations', 'publishers', 'models'])
const isVersionSegment = (value) => API_VERSION_REGEX.test(String(value || ''))

const DEFAULT_API_BASES = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com',
}

const ensureProtocol = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`

const resolveApiUrl = (apiUrl, apiFormat) => {
  const trimmed = String(apiUrl || '').trim()
  if (trimmed) return trimmed
  return DEFAULT_API_BASES[apiFormat] || DEFAULT_API_BASES.openai
}

const normalizeApiBase = (apiUrl = '') => {
  const cleaned = String(apiUrl).trim().replace(/\/+$/, '')
  if (!cleaned) {
    return { origin: '', segments: [], host: '' }
  }
  try {
    const url = new URL(ensureProtocol(cleaned))
    return {
      origin: `${url.protocol}//${url.host}`,
      segments: url.pathname.split('/').filter(Boolean),
      host: url.host.toLowerCase(),
    }
  } catch {
    return { origin: cleaned, segments: [], host: '' }
  }
}

const extractVertexProjectId = (apiUrl = '') => {
  const { segments } = normalizeApiBase(apiUrl)
  const index = segments.indexOf('projects')
  if (index < 0) return null
  const candidate = segments[index + 1]
  if (!candidate) return null
  if (apiMarkerSegments.has(candidate)) return null
  if (API_VERSION_REGEX.test(candidate)) return null
  return candidate
}

const inferApiVersionFromUrl = (apiUrl = '') => {
  const cleaned = String(apiUrl).trim()
  if (!cleaned) return null
  try {
    const url = new URL(ensureProtocol(cleaned))
    const segments = url.pathname.split('/').filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
      if (API_VERSION_REGEX.test(segment)) return segment
    }
    return null
  } catch {
    const segments = cleaned.split('/').filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
      if (API_VERSION_REGEX.test(segment)) return segment
    }
    return null
  }
}

const resolveApiVersion = (apiUrl, apiVersion, fallback) => {
  const inferred = inferApiVersionFromUrl(apiUrl)
  if (inferred) return inferred
  const trimmed = String(apiVersion || '').trim()
  return trimmed || fallback
}

const buildGeminiContentsFromMessages = (messages = []) => {
  const parts = []
  messages.forEach((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push({ text: part.text })
      }
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url
        if (!url) return
        const parsed = parseDataUrl(url)
        if (parsed?.buffer) {
          parts.push({
            inline_data: {
              mime_type: parsed.contentType || 'image/png',
              data: parsed.buffer.toString('base64'),
            },
          })
        } else if (typeof url === 'string') {
          parts.push({ file_data: { file_uri: url } })
        }
      }
    })
  })
  return [{ role: 'user', parts }]
}

const buildGeminiRequest = (config) => {
  const apiFormat = config?.apiFormat || 'openai'
  const format = apiFormat === 'vertex' ? 'vertex' : 'gemini'
  const apiUrl = resolveApiUrl(config?.apiUrl, format)
  const baseInfo = normalizeApiBase(apiUrl)
  const baseOrigin = baseInfo.origin || String(apiUrl || '').replace(/\/+$/, '')
  const versionFallback = format === 'vertex' ? 'v1beta1' : 'v1beta'
  const version = resolveApiVersion(apiUrl, config?.apiVersion, versionFallback)
  const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl))
  const segments = [...baseInfo.segments]

  if (!hasVersion && version) {
    const markerIndex = segments.findIndex((segment) => apiMarkerSegments.has(segment))
    if (markerIndex >= 0) {
      segments.splice(markerIndex, 0, version)
    } else {
      segments.push(version)
    }
  }

  const modelValue = String(config?.model || '').trim()
  if (!modelValue) {
    throw new Error('模型名称未配置')
  }

  const modelSegments = modelValue.split('/').filter(Boolean)
  const modelHasProjectPath = modelSegments.includes('projects')
  const geminiModelIsPath = modelSegments[0] === 'models'
  const normalizedModel = geminiModelIsPath ? modelSegments.slice(1).join('/') : modelValue

  const applyModelPath = () => {
    const modelIndex = segments.indexOf('models')
    if (geminiModelIsPath) {
      if (modelIndex >= 0 && modelSegments[0] === 'models') {
        segments.splice(modelIndex + 1)
        segments.push(...modelSegments.slice(1))
      } else {
        segments.push(...modelSegments)
      }
      return
    }
    if (modelIndex >= 0) {
      segments.splice(modelIndex + 1)
      segments.push(modelValue)
    } else {
      segments.push('models', modelValue)
    }
  }

  const ensureMarkerValue = (marker, value) => {
    const idx = segments.indexOf(marker)
    if (idx === -1) {
      if (!value) return false
      segments.push(marker, value)
      return true
    }
    const next = segments[idx + 1]
    if (!next || apiMarkerSegments.has(next) || isVersionSegment(next)) {
      if (!value) return false
      segments.splice(idx + 1, 0, value)
      return true
    }
    return true
  }

  if (format === 'vertex') {
    const projectId =
      String(config?.vertexProjectId || '').trim() ||
      extractVertexProjectId(apiUrl) ||
      ''
    const location = String(config?.vertexLocation || '').trim() || 'us-central1'
    const publisher = String(config?.vertexPublisher || '').trim() || 'google'
    const hasProjectsMarker = segments.includes('projects')
    const useVertexMarkers = Boolean(projectId || hasProjectsMarker || modelHasProjectPath)

    if (modelHasProjectPath) {
      segments.push(...modelSegments)
    } else if (useVertexMarkers) {
      if (projectId) {
        ensureMarkerValue('projects', projectId)
      }
      if (segments.includes('projects') || projectId) {
        ensureMarkerValue('locations', location)
        ensureMarkerValue('publishers', publisher)
      }
      if (segments.includes('projects') || projectId) {
        ensureMarkerValue('models', normalizedModel)
      } else {
        applyModelPath()
      }
    } else {
      applyModelPath()
    }
  } else {
    applyModelPath()
  }

  const suffix = config?.stream ? ':streamGenerateContent' : ':generateContent'
  let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`
  const headers = {
    'Content-Type': 'application/json',
    Connection: 'close',
  }
  const isOfficial =
    format === 'vertex'
      ? baseInfo.host === 'aiplatform.googleapis.com'
      : baseInfo.host === 'generativelanguage.googleapis.com'
  if (isOfficial) {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config?.apiKey || '')}`
  } else {
    headers.Authorization = `Bearer ${config?.apiKey || ''}`
  }
  return { url, headers }
}

const readGeminiStream = async (response) => {
  const reader = response.body?.getReader()
  if (!reader) {
    return response.json()
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let lastJson = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (!line) continue
      const cleaned = line.replace(/^data:\s*/i, '').trim()
      if (!cleaned || cleaned === '[DONE]') continue
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  const tail = decoder.decode()
  if (tail) buffer += tail
  const remainder = buffer.trim()
  if (remainder) {
    const cleaned = remainder.replace(/^data:\s*/i, '').trim()
    if (cleaned && cleaned !== '[DONE]') {
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  return lastJson
}

const readResponseError = async (response) => {
  const fallback = response.statusText || `HTTP ${response.status}`
  try {
    const text = await response.text()
    if (!text) return fallback
    try {
      const data = JSON.parse(text)
      return data?.error?.message || data?.message || text
    } catch {
      return text
    }
  } catch {
    return fallback
  }
}

const normalizeGlobalConfig = (input = {}) => ({
  apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
  apiUrl: typeof input.apiUrl === 'string' ? input.apiUrl : DEFAULT_BACKEND_CONFIG.apiUrl,
  apiFormat:
    input.apiFormat === 'gemini' || input.apiFormat === 'vertex' ? input.apiFormat : 'openai',
  apiVersion: typeof input.apiVersion === 'string' ? input.apiVersion : 'v1',
  vertexProjectId:
    typeof input.vertexProjectId === 'string'
      ? input.vertexProjectId
      : DEFAULT_BACKEND_CONFIG.vertexProjectId,
  vertexLocation:
    typeof input.vertexLocation === 'string'
      ? input.vertexLocation
      : DEFAULT_BACKEND_CONFIG.vertexLocation,
  vertexPublisher:
    typeof input.vertexPublisher === 'string'
      ? input.vertexPublisher
      : DEFAULT_BACKEND_CONFIG.vertexPublisher,
  modelWhitelist: Array.isArray(input.modelWhitelist)
    ? input.modelWhitelist.filter((item) => typeof item === 'string' && item.trim())
    : [],
})

const getGlobalConfig = () => {
  const db = getDb()
  const row = db.prepare('SELECT * FROM global_config WHERE id = 1').get()
  if (!row) {
    return normalizeGlobalConfig({})
  }
  return normalizeGlobalConfig({
    apiKey: row.api_key || '',
    apiUrl: row.api_url || '',
    apiFormat: row.api_format || '',
    apiVersion: row.api_version || '',
    vertexProjectId: row.vertex_project_id || '',
    vertexLocation: row.vertex_location || '',
    vertexPublisher: row.vertex_publisher || '',
    modelWhitelist: safeJsonParse(row.model_whitelist_json, []),
  })
}

const saveGlobalConfig = (payload) => {
  const db = getDb()
  const normalized = normalizeGlobalConfig(payload)
  const now = Date.now()
  const existing = db.prepare('SELECT id FROM global_config WHERE id = 1').get()
  if (existing) {
    db.prepare(
      `UPDATE global_config
       SET api_key = ?, api_url = ?, api_format = ?, api_version = ?, vertex_project_id = ?, vertex_location = ?, vertex_publisher = ?, model_whitelist_json = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      normalized.apiKey,
      normalized.apiUrl,
      normalized.apiFormat,
      normalized.apiVersion,
      normalized.vertexProjectId,
      normalized.vertexLocation,
      normalized.vertexPublisher,
      JSON.stringify(normalized.modelWhitelist),
      now,
    )
  } else {
    db.prepare(
      `INSERT INTO global_config (id, api_key, api_url, api_format, api_version, vertex_project_id, vertex_location, vertex_publisher, model_whitelist_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      normalized.apiKey,
      normalized.apiUrl,
      normalized.apiFormat,
      normalized.apiVersion,
      normalized.vertexProjectId,
      normalized.vertexLocation,
      normalized.vertexPublisher,
      JSON.stringify(normalized.modelWhitelist),
      now,
    )
  }
  return normalized
}

const buildModelCacheKey = (apiFormat, apiUrl, apiVersion) =>
  `${apiFormat || ''}::${apiUrl || ''}::${apiVersion || ''}`

const getModelCache = (apiFormat, apiUrl, apiVersion) => {
  const db = getDb()
  const key = buildModelCacheKey(apiFormat, apiUrl, apiVersion)
  const row = db
    .prepare('SELECT models_json, updated_at FROM model_cache WHERE id = ?')
    .get(key)
  if (!row) return null
  return {
    models: safeJsonParse(row.models_json, []),
    updatedAt: row.updated_at,
  }
}

const saveModelCache = (apiFormat, apiUrl, apiVersion, models) => {
  const db = getDb()
  const key = buildModelCacheKey(apiFormat, apiUrl, apiVersion)
  const now = Date.now()
  db.prepare(
    `INSERT INTO model_cache (id, api_format, api_url, api_version, models_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       api_format = excluded.api_format,
       api_url = excluded.api_url,
       api_version = excluded.api_version,
       models_json = excluded.models_json,
       updated_at = excluded.updated_at`,
  ).run(
    key,
    apiFormat || '',
    apiUrl || '',
    apiVersion || '',
    JSON.stringify(models || []),
    now,
  )
  return { models: models || [], updatedAt: now }
}

const requestImageUrl = async (config, globalConfig, messages, signal) => {
  const apiKey = globalConfig?.apiKey || ''
  if (!apiKey) {
    throw new Error('API Key 未配置')
  }
  if (!config?.model) {
    throw new Error('模型名称未配置')
  }

  const whitelist = Array.isArray(globalConfig?.modelWhitelist)
    ? globalConfig.modelWhitelist
    : []
  if (whitelist.length && !whitelist.includes(String(config.model))) {
    throw new Error('模型不在管理员白名单中')
  }

  const apiFormat = globalConfig?.apiFormat || 'openai'
  const apiUrl = resolveApiUrl(
    globalConfig?.apiUrl,
    apiFormat === 'vertex' ? 'vertex' : apiFormat,
  )
  const versionFallback =
    apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta'
  const apiVersion = resolveApiVersion(
    apiUrl,
    globalConfig?.apiVersion,
    versionFallback,
  )
  const mergedConfig = {
    ...config,
    apiKey,
    apiFormat,
    apiUrl,
    apiVersion,
    vertexProjectId: globalConfig?.vertexProjectId,
    vertexLocation: globalConfig?.vertexLocation,
    vertexPublisher: globalConfig?.vertexPublisher,
  }

  if (apiFormat !== 'openai') {
    const requestInfo = {
      url: '',
      model: mergedConfig.model,
      stream: Boolean(mergedConfig.stream),
      format: apiFormat,
    }
    let response
    let data
    try {
      const contents = buildGeminiContentsFromMessages(messages)
      const built = buildGeminiRequest(mergedConfig)
      requestInfo.url = built.url
      logBackendOutbound('api-request', requestInfo)
      response = await fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify({ contents }),
        signal,
      })
      data = mergedConfig.stream ? await readGeminiStream(response) : await response.json()
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }

    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    if (!response.ok) {
      const message =
        data?.error?.message ||
        (typeof data === 'string' ? data : '') ||
        response.statusText
      logBackendResponse('json-error', { status: response.status, message })
      throw new Error(message)
    }

    if (data?.error?.message) {
      throw new Error(data.error.message)
    }
    const imageUrl = resolveImageFromResponse(data)
    if (!imageUrl) {
      logBackendResponse('json-response', data)
    }
    return imageUrl
  }

  const baseInfo = normalizeApiBase(apiUrl)
  const basePath = baseInfo.origin
    ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
    : String(apiUrl || '').replace(/\/+$/, '')
  const version = resolveApiVersion(apiUrl, mergedConfig.apiVersion, 'v1')
  const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl))
  const openAiBase = hasVersion ? basePath : `${basePath}/${version}`
  const chatUrl = openAiBase.endsWith('/chat/completions')
    ? openAiBase
    : `${openAiBase}/chat/completions`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
    Connection: 'close',
  }

  if (mergedConfig.stream) {
    const requestInfo = {
      url: chatUrl,
      model: mergedConfig.model,
      stream: true,
    }
    logBackendOutbound('api-request', requestInfo)
    let response
    try {
      response = await fetch(requestInfo.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: mergedConfig.model, messages, stream: true }),
        signal,
      })
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }
    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    if (!response.ok) {
      const message = await readResponseError(response)
      logBackendResponse('stream-error', { status: response.status, message })
      throw new Error(message)
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text()
      let imageUrl = null
      if (text) {
        try {
          const parsed = JSON.parse(text)
          imageUrl = resolveImageFromResponse(parsed)
          if (!imageUrl) {
            logBackendResponse('json-response', parsed)
          }
        } catch {
          imageUrl = parseMarkdownImage(text)
          if (!imageUrl) {
            logBackendResponse('stream-response', text)
          }
        }
      }
      return imageUrl
    }

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let generatedText = ''
    let pending = ''
    let imageUrl = null
    const consumeLine = (line) => {
      const cleaned = line.replace(/\r$/, '').trim()
      if (!cleaned) return
      let payload = null
      if (cleaned.startsWith('data:')) {
        payload = cleaned.slice(5).trimStart()
        if (!payload || payload === '[DONE]') return
      } else if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
        payload = cleaned
      } else {
        return
      }
      try {
        const json = JSON.parse(payload)
        if (!imageUrl) {
          const resolved = resolveImageFromResponse(json)
          if (resolved) {
            imageUrl = resolved
            return
          }
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.content) {
          if (typeof delta.content === 'string') {
            generatedText += delta.content
          } else if (Array.isArray(delta.content)) {
            delta.content.forEach((part) => {
              if (part?.type === 'text' && typeof part.text === 'string') {
                generatedText += part.text
              }
              if (part?.type === 'image_url') {
                const url = part?.image_url?.url || part?.image_url
                if (typeof url === 'string' && !imageUrl) {
                  imageUrl = parseMarkdownImage(url) || url
                }
              }
            })
          }
        }
        if (typeof delta?.reasoning_content === 'string') {
          generatedText += delta.reasoning_content
        }
        const messageContent = json.choices?.[0]?.message?.content
        if (typeof messageContent === 'string') {
          generatedText += messageContent
        } else if (Array.isArray(messageContent)) {
          messageContent.forEach((part) => {
            if (part?.type === 'text' && typeof part.text === 'string') {
              generatedText += part.text
            }
            if (part?.type === 'image_url') {
              const url = part?.image_url?.url || part?.image_url
              if (typeof url === 'string' && !imageUrl) {
                imageUrl = parseMarkdownImage(url) || url
              }
            }
          })
        }
      } catch {
        if (!imageUrl) {
          imageUrl = parseMarkdownImage(payload)
        }
      }
    }
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex)
          pending = pending.slice(newlineIndex + 1)
          consumeLine(line)
          newlineIndex = pending.indexOf('\n')
        }
      }
      const tail = decoder.decode()
      if (tail) pending += tail
    }
    if (pending) {
      consumeLine(pending)
    }
    if (imageUrl) return imageUrl
    const parsedUrl = parseMarkdownImage(generatedText)
    if (!parsedUrl) {
      logBackendResponse('stream-response', generatedText)
    }
    return parsedUrl
  }

  const requestInfo = {
    url: chatUrl,
    model: mergedConfig.model,
    stream: false,
  }
  logBackendOutbound('api-request', requestInfo)
  let response
  try {
    response = await fetch(requestInfo.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: mergedConfig.model, messages, stream: false }),
      signal,
    })
  } catch (err) {
    logBackendOutbound('api-request-error', {
      ...requestInfo,
      error: describeFetchError(err),
    })
    throw err
  }
  logBackendOutbound('api-response', { ...requestInfo, status: response.status })
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendResponse('json-error', { status: response.status, message })
    throw new Error(message)
  }
  const data = await response.json()
  const imageUrl = resolveImageFromResponse(data)
  if (!imageUrl) {
    logBackendResponse('json-response', data)
  }
  return imageUrl
}

const downloadImageBuffer = async (imageUrl) => {
  if (!imageUrl) return null
  if (imageUrl.startsWith('data:image')) {
    const parsed = parseDataUrl(imageUrl)
    if (!parsed) return null
    return parsed
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    return null
  }
  let response
  try {
    response = await fetch(imageUrl, { headers: { Connection: 'close' } })
  } catch (err) {
    logBackendOutbound('image-download-error', {
      url: imageUrl,
      error: describeFetchError(err),
    })
    throw err
  }
  if (!response.ok) {
    logBackendOutbound('image-download-response', {
      url: imageUrl,
      status: response.status,
    })
    throw new Error(response.statusText)
  }
  const arrayBuffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  return { buffer: Buffer.from(arrayBuffer), contentType }
}

const scheduleRetry = (userId, taskId, subTaskId) => {
  if (retryTimers.has(subTaskId)) return
  const timer = setTimeout(async () => {
    retryTimers.delete(subTaskId)
    const taskState = await loadTaskState(userId, taskId)
    if (!taskState) return
    const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
    if (resultIndex === -1) return
    const current = taskState.results[resultIndex]
    if (current?.autoRetry === false) return
    if (current.status !== 'loading') return
    void runSubTask(userId, taskId, subTaskId)
  }, RETRY_DELAY_MS)
  retryTimers.set(subTaskId, timer)
}

const runSubTask = async (userId, taskId, subTaskId, options = {}) => {
  const countRequest = options.countRequest !== false
  if (activeControllers.has(subTaskId)) return
  clearRetryTimer(subTaskId)
  const controller = new AbortController()
  activeControllers.set(subTaskId, controller)
  let debugContext = { userId, taskId, subTaskId }

  const taskState = await loadTaskState(userId, taskId)
  if (!taskState) {
    activeControllers.delete(subTaskId)
    return
  }
  const requestPrompt = typeof taskState.prompt === 'string' ? taskState.prompt : ''
  const requestUploads = Array.isArray(taskState.uploads) ? taskState.uploads : []

  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) {
    activeControllers.delete(subTaskId)
    return
  }

  const currentResult = taskState.results[resultIndex]
  const startTime =
    typeof currentResult?.startTime === 'number' && Number.isFinite(currentResult.startTime)
      ? currentResult.startTime
      : Date.now()
  taskState.results[resultIndex] = {
    ...currentResult,
    status: 'loading',
    error: currentResult?.error,
    startTime,
    endTime: undefined,
    duration: undefined,
    autoRetry: currentResult?.autoRetry !== false,
    savedLocal: false,
  }
  if (countRequest) {
    taskState.stats = updateStats(taskState.stats, 'request')
  }
  await saveTaskState(userId, taskId, taskState)
  if (countRequest) {
    await updateGlobalStats(userId, 'request')
  }

  try {
    const backendState = await loadBackendState(userId)
    const globalConfig = getGlobalConfig()
    debugContext = {
      ...debugContext,
      model: backendState?.config?.model || '',
      apiFormat: globalConfig?.apiFormat || '',
    }
    const shouldCollect = Boolean(backendState?.config?.enableCollection)
    const messages = await buildMessagesForTask(userId, taskState)
    const imageUrl = await requestImageUrl(
      backendState.config,
      globalConfig,
      messages,
      controller.signal,
    )
    debugContext = { ...debugContext, imageUrl }
    if (!imageUrl) {
      throw new Error('未在响应中找到图片数据')
    }
    const downloaded = await downloadImageBuffer(imageUrl)
    if (!downloaded) {
      throw new Error('图片下载失败')
    }
    const saved = await saveBackendImageBuffer(userId, downloaded.buffer, downloaded.contentType)
    const endTime = Date.now()
    const duration = endTime - startTime

    const freshState = await loadTaskState(userId, taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    freshState.results[freshIndex] = {
      ...freshState.results[freshIndex],
      status: 'success',
      error: undefined,
      localKey: saved.fileName,
      sourceUrl: `/api/backend/image/${encodeURIComponent(saved.fileName)}`,
      savedLocal: false,
      autoRetry: false,
      endTime,
      duration,
    }
    freshState.stats = updateStats(freshState.stats, 'success', duration)
    await saveTaskState(userId, taskId, freshState)
    await updateGlobalStats(userId, 'success', duration)
    if (shouldCollect) {
      const items = []
      const timestamp = endTime
      const taskKey = typeof taskId === 'string' ? taskId : ''
      const prompt = requestPrompt || ''
      if (saved?.fileName) {
        items.push({
          id: buildResultCollectionKey(subTaskId, timestamp),
          prompt,
          timestamp,
          taskId: taskKey,
          localKey: path.basename(String(saved.fileName)),
        })
      }
      if (requestUploads.length > 0) {
        requestUploads.forEach((upload) => {
          const uploadKey =
            typeof upload?.uid === 'string' && upload.uid
              ? upload.uid
              : typeof upload?.localKey === 'string'
                ? upload.localKey
                : ''
          const uploadLocalKey =
            typeof upload?.localKey === 'string' && upload.localKey
              ? path.basename(upload.localKey)
              : ''
          if (!uploadKey || !uploadLocalKey) return
          const signature =
            typeof upload?.sourceSignature === 'string' && upload.sourceSignature
              ? upload.sourceSignature
              : buildUploadSignature(upload)
          items.push({
            id: buildUploadCollectionKey(taskKey, uploadKey),
            prompt,
            timestamp,
            taskId: taskKey,
            localKey: uploadLocalKey,
            sourceSignature: signature || undefined,
          })
        })
      }
      appendBackendCollectionItems(userId, items)
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return
    }
    console.error('backend subtask error:', {
      ...debugContext,
      error: describeFetchError(err) || err?.message || String(err),
    })
    const errorMessage = err?.message || '未知错误'
    const freshState = await loadTaskState(userId, taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    const current = freshState.results[freshIndex]
    const shouldRetry = current?.autoRetry !== false
    if (shouldRetry) {
      freshState.results[freshIndex] = {
        ...current,
        status: 'loading',
        error: `${errorMessage} (1s后重试...)`,
        retryCount: (current.retryCount || 0) + 1,
        autoRetry: true,
      }
      await saveTaskState(userId, taskId, freshState)
      scheduleRetry(userId, taskId, subTaskId)
    } else {
      freshState.results[freshIndex] = {
        ...current,
        status: 'error',
        error: errorMessage,
        endTime: Date.now(),
        autoRetry: false,
      }
      await saveTaskState(userId, taskId, freshState)
    }
  } finally {
    activeControllers.delete(subTaskId)
  }
}

const startGeneration = async (userId, taskId) => {
  const taskState = (await loadTaskState(userId, taskId)) || createDefaultTaskState()
  const previousState = {
    ...taskState,
    results: Array.isArray(taskState.results) ? [...taskState.results] : [],
    uploads: Array.isArray(taskState.uploads) ? [...taskState.uploads] : [],
  }
  taskState.results.forEach((result) => {
    abortActiveController(result.id)
    clearRetryTimer(result.id)
  })
  const concurrency = normalizeConcurrency(taskState.concurrency)
  const startTime = Date.now()
  taskState.results = Array.from({ length: concurrency }).map(() => ({
    id: crypto.randomUUID(),
    status: 'loading',
    retryCount: 0,
    startTime,
    autoRetry: true,
    savedLocal: false,
  }))
  taskState.stats = updateStats(taskState.stats, 'request', undefined, concurrency)
  await saveTaskState(userId, taskId, taskState)
  await updateGlobalStats(userId, 'request', undefined, concurrency)
  const removedKeys = getRemovedImageKeys(previousState, taskState)
  await cleanupUnusedImages(userId, removedKeys)
  scheduleOrphanCleanup(userId)
  taskState.results.forEach((result) => {
    void runSubTask(userId, taskId, result.id, { countRequest: false })
  })
  return taskState
}

const retrySubTask = async (userId, taskId, subTaskId) => {
  const taskState = await loadTaskState(userId, taskId)
  if (!taskState) return null
  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) return taskState
  const startTime = Date.now()
  const current = taskState.results[resultIndex]
  const removedKey = current?.localKey
  clearRetryTimer(subTaskId)
  taskState.results[resultIndex] = {
    ...current,
    status: 'loading',
    error: undefined,
    retryCount: current.retryCount || 0,
    startTime,
    endTime: undefined,
    duration: undefined,
    localKey: undefined,
    sourceUrl: undefined,
    autoRetry: true,
    savedLocal: false,
  }
  await saveTaskState(userId, taskId, taskState)
  if (removedKey) {
    await cleanupUnusedImages(userId, [removedKey])
  }
  scheduleOrphanCleanup(userId)
  void runSubTask(userId, taskId, subTaskId)
  return taskState
}

const normalizeStopMode = (mode) => (mode === 'abort' ? 'abort' : 'pause')

const stopSubTask = async (userId, taskId, subTaskId, mode = 'pause') => {
  const taskState = await loadTaskState(userId, taskId)
  if (!taskState) return null
  const resolvedMode = normalizeStopMode(mode)
  const shouldAbort = resolvedMode === 'abort'
  const targets = subTaskId
    ? taskState.results.filter((item) => item.id === subTaskId)
    : taskState.results

  targets.forEach((target) => {
    if (shouldAbort) {
      abortActiveController(target.id)
    }
    clearRetryTimer(target.id)
  })

  const nextResults = taskState.results.map((item) => {
    if (subTaskId && item.id !== subTaskId) return item
    if (item.status !== 'loading') return item
    return {
      ...item,
      status: 'error',
      error: shouldAbort ? '已停止' : '已暂停重试',
      autoRetry: false,
      endTime: shouldAbort ? Date.now() : item.endTime,
    }
  })
  const nextState = { ...taskState, results: nextResults }
  await saveTaskState(userId, taskId, nextState)
  return nextState
}

const SQLiteStore = connectSqlite3(session)
const sessionDir = path.dirname(dbPath)
const sessionDbName = path.basename(dbPath)
fs.mkdirSync(sessionDir, { recursive: true })

const app = express()

if (isProd) {
  app.set('trust proxy', 1)
}

app.use(
  session({
    name: 'moe_atelier_pro_sid',
    store: new SQLiteStore({
      db: sessionDbName,
      dir: sessionDir,
      ttl: sessionTtlSeconds,
    }),
    secret: sessionSecret || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
      maxAge: sessionTtlSeconds * 1000,
    },
  }),
)

if (!sessionSecret) {
  console.warn('SESSION_SECRET 未配置，当前使用默认值，仅适用于本地开发')
}

app.use((req, _res, next) => {
  if (req.session?.userId) {
    req.user = {
      id: req.session.userId,
      role: req.session.userRole,
      username: req.session.username,
    }
  }
  next()
})

app.use(express.json({ limit: '50mb' }))
if (backendLogRequests) {
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      logBackendRequest('http', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      })
    })
    next()
  })
}

const requireAuth = (req, res, next) => {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

const requireAdmin = (req, res, next) => {
  if (!req.user?.id || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

void ensureBootstrapAdmin({
  username: adminBootstrapUsername,
  password: adminBootstrapPassword,
}).catch((err) => {
  console.warn('初始化管理员失败:', err)
})

const PROMPT_MANAGER_URL = 'https://prompt.vioaki.xyz/api/gallery'

app.get('/api/prompt-manager', async (_req, res) => {
  try {
    const response = await fetch(PROMPT_MANAGER_URL, {
      headers: { Accept: 'application/json', Connection: 'close' },
    })
    if (!response.ok) {
      const message = await readResponseError(response)
      res.status(response.status).json({ error: message })
      return
    }
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('prompt-manager proxy error:', err)
    res.status(500).json({ error: 'Proxy Error' })
  }
})

app.get('/api/auth/captcha', (_req, res) => {
  cleanupExpiredCaptcha()
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 2,
    ignoreChars: '0o1i',
    color: true,
    background: '#FFF0F3',
  })
  const record = createCaptcha(captcha.text, 2 * 60 * 1000)
  res.json({ id: record.id, svg: captcha.data })
})

app.post('/api/auth/login', async (req, res) => {
  const { username, password, captchaId, captchaCode } = req.body || {}
  if (!captchaId || !captchaCode || !verifyCaptcha(captchaId, captchaCode)) {
    res.status(400).json({ error: '验证码错误或已过期' })
    return
  }
  const user = getUserByUsername(username)
  if (!user || user.disabled) {
    res.status(401).json({ error: '账号不存在或已禁用' })
    return
  }
  const ok = await verifyPassword(password || '', user.password_hash)
  if (!ok) {
    res.status(401).json({ error: '账号或密码错误' })
    return
  }
  req.session.userId = user.id
  req.session.userRole = user.role
  req.session.username = user.username
  updateLastLogin(user.id)
  res.json({ user: { id: user.id, username: user.username, role: user.role } })
})

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true })
  })
})

app.get('/api/auth/me', (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } })
})

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body || {}
    const created = await createUser({
      username,
      password,
      role: role === 'admin' ? 'admin' : 'user',
    })
    res.json(created)
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Create Error' })
  }
})

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(listUsers())
})

app.get('/api/admin/config', requireAdmin, (_req, res) => {
  res.json(getGlobalConfig())
})

app.put('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const saved = saveGlobalConfig(req.body || {})
    res.json(saved)
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Config Error' })
  }
})

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const db = getDb()
  const rows = db.prepare('SELECT global_stats_json FROM user_state').all()
  const summary = { ...DEFAULT_GLOBAL_STATS }
  rows.forEach((row) => {
    const stats = safeJsonParse(row.global_stats_json, {})
    summary.totalRequests += stats.totalRequests || 0
    summary.successCount += stats.successCount || 0
    summary.totalTime += stats.totalTime || 0
    if (typeof stats.fastestTime === 'number' && stats.fastestTime > 0) {
      summary.fastestTime =
        summary.fastestTime === 0 ? stats.fastestTime : Math.min(summary.fastestTime, stats.fastestTime)
    }
    if (typeof stats.slowestTime === 'number' && stats.slowestTime > summary.slowestTime) {
      summary.slowestTime = stats.slowestTime
    }
  })
  const userCount = db.prepare('SELECT COUNT(1) as count FROM users').get()?.count || 0
  const taskCount = db.prepare('SELECT COUNT(1) as count FROM tasks').get()?.count || 0
  res.json({ users: userCount, tasks: taskCount, stats: summary })
})

app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  const db = getDb()
  const userId = typeof req.query.userId === 'string' ? req.query.userId : ''
  const params = userId ? [userId] : []
  const where = userId ? 'WHERE t.user_id = ?' : ''
  const rows = db
    .prepare(
      `SELECT t.id, t.user_id, t.prompt, t.updated_at, u.username
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.updated_at DESC`,
    )
    .all(...params)
  res.json(rows)
})

app.get('/api/admin/task/:id', requireAdmin, async (req, res) => {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT t.id, t.user_id, u.username
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
    )
    .get(req.params.id)
  if (!row) {
    res.status(404).json({ error: 'Not Found' })
    return
  }
  const taskState = await loadTaskState(row.user_id, row.id)
  if (!taskState) {
    res.status(404).json({ error: 'Not Found' })
    return
  }
  const adminResults = Array.isArray(taskState.results)
    ? taskState.results.map((item) => ({
        ...item,
        sourceUrl: item.localKey
          ? `/api/admin/image/${encodeURIComponent(row.user_id)}/${encodeURIComponent(item.localKey)}`
          : item.sourceUrl,
      }))
    : []
  res.json({
    user: { id: row.user_id, username: row.username },
    task: { ...taskState, results: adminResults },
  })
})

app.get('/api/admin/image/:userId/:key', requireAdmin, async (req, res) => {
  try {
    const filePath = getBackendImagePath(req.params.userId, req.params.key)
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.sendFile(filePath)
  } catch (err) {
    console.error('admin image error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.get('/api/backend/stream', requireAuth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 2000\n\n')
  addSseClient(res, { userId: req.user.id, isAdmin: req.user.role === 'admin' })
  req.on('close', () => {
    removeSseClient(res)
  })
  try {
    const state = await loadBackendState(req.user.id)
    sendSseEvent(res, 'state', state)
  } catch (err) {
    console.warn('初始化事件流状态失败:', err)
  }
})

app.get('/api/backend/state', requireAuth, async (req, res) => {
  try {
    const state = await loadBackendState(req.user.id)
    res.json(state)
  } catch (err) {
    console.error('backend state error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.patch('/api/backend/state', requireAuth, async (req, res) => {
  try {
    const current = await loadBackendState(req.user.id)
    const next = { ...current }
    if (req.body?.configByFormat) {
      const incoming = req.body.configByFormat
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        next.configByFormat = { ...next.configByFormat, ...incoming }
      }
    }
    if (req.body?.config) {
      const incomingConfig = { ...req.body.config }
      if ('apiKey' in incomingConfig) {
        delete incomingConfig.apiKey
      }
      next.config = { ...DEFAULT_BACKEND_CONFIG, ...incomingConfig }
      const apiFormat =
        next.config.apiFormat === 'gemini' || next.config.apiFormat === 'vertex'
          ? next.config.apiFormat
          : 'openai'
      next.config.apiFormat = apiFormat
      next.configByFormat = {
        ...next.configByFormat,
        [apiFormat]: pickFormatConfig(next.config),
      }
    }
    if (Array.isArray(req.body?.tasksOrder)) {
      next.tasksOrder = Array.from(new Set(req.body.tasksOrder.filter((id) => typeof id === 'string')))
    }
    if (req.body?.globalStats) {
      next.globalStats = { ...DEFAULT_GLOBAL_STATS, ...req.body.globalStats }
    }
    await saveBackendState(req.user.id, next)
    res.json(next)
  } catch (err) {
    console.error('backend state write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.post('/api/backend/models', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const globalConfig = getGlobalConfig()
    if (!globalConfig.apiKey) {
      res.status(400).json({ error: 'API Key 未配置' })
      return
    }
    const isAdmin = req.user?.role === 'admin' || req.session?.user?.role === 'admin'
    const apiFormat =
      isAdmin && payload.apiFormat ? payload.apiFormat : globalConfig.apiFormat || 'openai'
    const apiUrl = resolveApiUrl(
      isAdmin && payload.apiUrl ? payload.apiUrl : globalConfig.apiUrl,
      apiFormat === 'vertex' ? 'vertex' : apiFormat,
    )
    const versionFallback =
      apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta'
    const version = resolveApiVersion(
      apiUrl,
      isAdmin && payload.apiVersion ? payload.apiVersion : globalConfig.apiVersion,
      versionFallback,
    )
    const baseInfo = normalizeApiBase(apiUrl)
    const basePath = baseInfo.origin
      ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
      : String(apiUrl || '').trim().replace(/\/+$/, '')

    let url = ''
    const headers = {}

    if (apiFormat === 'openai') {
      const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl))
      const openAiBase = hasVersion ? basePath : `${basePath}/${version}`
      url = openAiBase.endsWith('/models') ? openAiBase : `${openAiBase}/models`
      headers.Authorization = `Bearer ${globalConfig.apiKey}`
    } else if (apiFormat === 'gemini') {
      const segments = [...baseInfo.segments]
      if (!inferApiVersionFromUrl(apiUrl)) {
        const modelIndex = segments.indexOf('models')
        if (modelIndex >= 0) {
          segments.splice(modelIndex, 0, version)
        } else {
          segments.push(version)
        }
      }
      const modelIndex = segments.indexOf('models')
      if (modelIndex >= 0) {
        segments.splice(modelIndex + 1)
      } else {
        segments.push('models')
      }
      const geminiBase = baseInfo.origin
        ? `${baseInfo.origin}/${segments.join('/')}`
        : `${segments.join('/')}`
      const isOfficial = baseInfo.host === 'generativelanguage.googleapis.com'
      if (isOfficial) {
        url = `${geminiBase}?key=${encodeURIComponent(globalConfig.apiKey)}`
      } else {
        url = geminiBase
        headers.Authorization = `Bearer ${globalConfig.apiKey}`
      }
    } else {
      res.status(400).json({ error: 'Vertex 模型列表暂不支持自动获取' })
      return
    }

    const response = await fetch(url, { headers })
    if (!response.ok) {
      const message = await readResponseError(response)
      res.status(response.status).json({ error: message })
      return
    }
    const data = await response.json()
    const pickModelValue = (item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const keys = [
        'id',
        'name',
        'model',
        'model_name',
        'modelId',
        'model_id',
        'value',
        'label',
        'slug',
      ]
      for (const key of keys) {
        const value = item[key]
        if (typeof value === 'string' && value.trim()) return value
      }
      return ''
    }
    const normalizeLabel = (value) => {
      if (typeof value !== 'string') return ''
      const trimmed = value.trim()
      if (!trimmed) return ''
      const parts = trimmed.split('/')
      return parts[parts.length - 1] || trimmed
    }
    const pickArray = (...candidates) => {
      for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate
      }
      return []
    }

    const list = pickArray(
      data,
      data?.data,
      data?.data?.data,
      data?.data?.models,
      data?.models,
      data?.models?.data,
      data?.model_list,
      data?.modelList,
      data?.items,
      data?.result,
      data?.available_models,
      data?.availableModels,
      data?.response?.data,
      data?.response?.models,
    )

    const modelOptions = list
      .map((item) => {
        const raw = pickModelValue(item)
        if (!raw) return null
        return { label: normalizeLabel(raw), value: raw }
      })
      .filter((item) => item && typeof item.value === 'string')
      .sort((a, b) => a.value.localeCompare(b.value))

    if (modelOptions.length) {
      saveModelCache(apiFormat, apiUrl, version, modelOptions)
    }

    const ignoreWhitelist = Boolean(payload?.ignoreWhitelist) && isAdmin
    const whitelist = Array.isArray(globalConfig.modelWhitelist) ? globalConfig.modelWhitelist : []
    const filtered =
      !ignoreWhitelist && whitelist.length
        ? modelOptions.filter((item) => whitelist.includes(item.value))
        : modelOptions

    if (!filtered.length) {
      const cached = getModelCache(apiFormat, apiUrl, version)
      if (cached?.models?.length) {
        const cachedFiltered =
          !ignoreWhitelist && whitelist.length
            ? cached.models.filter((item) => whitelist.includes(item.value))
            : cached.models
        res.json(cachedFiltered)
        return
      }
    }

    res.json(filtered)
  } catch (err) {
    const payload = req.body || {}
    const globalConfig = getGlobalConfig()
    const isAdmin = req.session?.user?.role === 'admin'
    const apiFormat =
      isAdmin && payload.apiFormat ? payload.apiFormat : globalConfig.apiFormat || 'openai'
    const apiUrl = resolveApiUrl(
      isAdmin && payload.apiUrl ? payload.apiUrl : globalConfig.apiUrl,
      apiFormat === 'vertex' ? 'vertex' : apiFormat,
    )
    const versionFallback =
      apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta'
    const version = resolveApiVersion(
      apiUrl,
      isAdmin && payload.apiVersion ? payload.apiVersion : globalConfig.apiVersion,
      versionFallback,
    )
    const cached = getModelCache(apiFormat, apiUrl, version)
    if (cached?.models?.length) {
      const isAdmin = req.user?.role === 'admin' || req.session?.user?.role === 'admin'
      const ignoreWhitelist = Boolean(payload?.ignoreWhitelist) && isAdmin
      const whitelist = Array.isArray(globalConfig.modelWhitelist) ? globalConfig.modelWhitelist : []
      const cachedFiltered =
        !ignoreWhitelist && whitelist.length
          ? cached.models.filter((item) => whitelist.includes(item.value))
          : cached.models
      res.json(cachedFiltered)
      return
    }
    console.error('backend models error:', err)
    res.status(500).json({ error: 'Model Error' })
  }
})

app.get('/api/backend/collection', requireAuth, async (req, res) => {
  try {
    const items = await loadBackendCollection(req.user.id)
    res.json(items)
  } catch (err) {
    console.error('backend collection read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/collection', requireAuth, async (req, res) => {
  try {
    const previous = await loadBackendCollection(req.user.id)
    const items = normalizeCollectionPayloadForSave(req.body)
    await saveBackendCollection(req.user.id, items)
    const prevKeys = collectImageKeysFromCollection(previous)
    const nextKeys = collectImageKeysFromCollection(items)
    const removedKeys = []
    for (const key of prevKeys) {
      if (!nextKeys.has(key)) removedKeys.push(key)
    }
    await cleanupUnusedImages(req.user.id, removedKeys)
    scheduleOrphanCleanup(req.user.id)
    res.json(items)
  } catch (err) {
    console.error('backend collection write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/task/:id', requireAuth, async (req, res) => {
  try {
    const taskId = req.params.id
    const taskState = await loadTaskState(req.user.id, taskId)
    if (!taskState) {
      const backendState = await loadBackendState(req.user.id)
      if (backendState.tasksOrder.includes(taskId)) {
        const next = createDefaultTaskState()
        await saveTaskState(req.user.id, taskId, next)
        res.json(next)
        return
      }
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(taskState)
  } catch (err) {
    console.error('backend task read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/task/:id', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const previous = await loadTaskState(req.user.id, req.params.id)
    const next = {
      ...createDefaultTaskState(),
      ...payload,
      concurrency: normalizeConcurrency(payload?.concurrency),
      stats: { ...DEFAULT_TASK_STATS, ...(payload?.stats || {}) },
      results: Array.isArray(payload?.results) ? payload.results : [],
      uploads: Array.isArray(payload?.uploads) ? payload.uploads : [],
    }
    await saveTaskState(req.user.id, req.params.id, next)
    if (previous) {
      const removedKeys = getRemovedImageKeys(previous, next)
      await cleanupUnusedImages(req.user.id, removedKeys)
    }
    scheduleOrphanCleanup(req.user.id)
    res.json(next)
  } catch (err) {
    console.error('backend task write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.patch('/api/backend/task/:id', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const current =
      (await loadTaskState(req.user.id, req.params.id)) || createDefaultTaskState()
    const next = {
      ...current,
      prompt: typeof payload.prompt === 'string' ? payload.prompt : current.prompt,
      concurrency: normalizeConcurrency(payload?.concurrency, current.concurrency || DEFAULT_CONCURRENCY),
      enableSound: typeof payload.enableSound === 'boolean' ? payload.enableSound : current.enableSound,
      uploads: Array.isArray(payload?.uploads) ? payload.uploads : current.uploads,
    }
    await saveTaskState(req.user.id, req.params.id, next)
    const removedKeys = getRemovedImageKeys(current, next)
    await cleanupUnusedImages(req.user.id, removedKeys)
    scheduleOrphanCleanup(req.user.id)
    res.json(next)
  } catch (err) {
    console.error('backend task patch error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.delete('/api/backend/task/:id', requireAuth, async (req, res) => {
  try {
    const existing = await loadTaskState(req.user.id, req.params.id)
    const removedKeys = existing ? Array.from(collectImageKeysFromTask(existing)) : []
    if (existing?.results) {
      existing.results.forEach((result) => {
        const controller = activeControllers.get(result.id)
        if (controller) {
          controller.abort()
          activeControllers.delete(result.id)
        }
        clearRetryTimer(result.id)
      })
    }
    const db = getDb()
    db.prepare('DELETE FROM task_results WHERE task_id = ?').run(req.params.id)
    db.prepare('DELETE FROM uploads WHERE task_id = ?').run(req.params.id)
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
    const state = await loadBackendState(req.user.id)
    const next = {
      ...state,
      tasksOrder: state.tasksOrder.filter((id) => id !== req.params.id),
    }
    await saveBackendState(req.user.id, next)
    await cleanupUnusedImages(req.user.id, removedKeys)
    await cleanupOrphanedImages(req.user.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('backend task delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/task/:id/generate', requireAuth, async (req, res) => {
  try {
    const state = await startGeneration(req.user.id, req.params.id)
    res.json(state)
  } catch (err) {
    console.error('backend generate error:', err)
    res.status(500).json({ error: 'Generate Error' })
  }
})

app.post('/api/backend/task/:id/retry', requireAuth, async (req, res) => {
  try {
    const { subTaskId } = req.body || {}
    if (!subTaskId) {
      res.status(400).json({ error: 'Missing subTaskId' })
      return
    }
    const state = await retrySubTask(req.user.id, req.params.id, subTaskId)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(state)
  } catch (err) {
    console.error('backend retry error:', err)
    res.status(500).json({ error: 'Retry Error' })
  }
})

app.post('/api/backend/task/:id/stop', requireAuth, async (req, res) => {
  try {
    const { subTaskId, mode } = req.body || {}
    const state = await stopSubTask(req.user.id, req.params.id, subTaskId, mode)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(state)
  } catch (err) {
    console.error('backend stop error:', err)
    res.status(500).json({ error: 'Stop Error' })
  }
})

app.post(
  '/api/backend/upload',
  requireAuth,
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    try {
      const buffer = req.body
      if (!buffer || !buffer.length) {
        res.status(400).json({ error: 'Empty Body' })
        return
      }
      const contentType = req.headers['content-type'] || 'application/octet-stream'
      const result = await saveBackendImageBuffer(req.user.id, buffer, contentType)
      res.json({
        key: result.fileName,
        url: `/api/backend/image/${encodeURIComponent(result.fileName)}`,
      })
    } catch (err) {
      console.error('backend upload error:', err)
      res.status(500).json({ error: 'Upload Error' })
    }
  },
)

app.get('/api/backend/image/:key', requireAuth, async (req, res) => {
  try {
    const filePath = getBackendImagePath(req.user.id, req.params.key)
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.sendFile(filePath)
  } catch (err) {
    console.error('backend image error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.delete('/api/backend/image/:key', requireAuth, async (req, res) => {
  try {
    const filePath = getBackendImagePath(req.user.id, req.params.key)
    if (!filePath) {
      res.status(400).json({ error: 'Missing Key' })
      return
    }
    await fs.promises.unlink(filePath).catch(() => undefined)
    res.json({ ok: true })
  } catch (err) {
    console.error('backend image delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/images/cleanup', requireAuth, async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : []
    const normalized = keys
      .map((key) => path.basename(String(key)))
      .filter((key) => key)
    await cleanupUnusedImages(req.user.id, normalized)
    scheduleOrphanCleanup(req.user.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('backend image cleanup error:', err)
    res.status(500).json({ error: 'Cleanup Error' })
  }
})

app.post('/api/save-image', async (req, res) => {
  try {
    const buffer = await readRequestBody(req)
    if (!buffer.length) {
      res.status(400).json({ error: 'Empty Body' })
      return
    }

    const typeHeader = req.headers['x-image-type']
    const contentType = Array.isArray(typeHeader)
      ? typeHeader[0]
      : (typeHeader || req.headers['content-type'] || '')

    const result = await saveImageBuffer(buffer, String(contentType))
    res.json(result)
  } catch (err) {
    console.error('save-image error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

if (isProd) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'custom',
  })

  app.use(vite.middlewares)
  app.get('*', async (req, res) => {
    try {
      const templatePath = path.join(rootDir, 'index.html')
      const template = await fs.promises.readFile(templatePath, 'utf-8')
      const html = await vite.transformIndexHtml(req.originalUrl, template)
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (err) {
      vite.ssrFixStacktrace(err)
      res.status(500).end(err.message)
    }
  })
}

app.listen(port, () => {
  console.log(`[server] http://localhost:${port} (${isProd ? 'prod' : 'dev'})`)
})


