import crypto from 'node:crypto'
import {
  DEFAULT_BACKEND_CONFIG,
  DEFAULT_CONCURRENCY,
  DEFAULT_GLOBAL_STATS,
  DEFAULT_TASK_STATS,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  pickFormatConfig,
} from './config.mjs'
import { broadcastSseEvent } from './sse.mjs'
import { getDb, nowMs, safeJsonParse, jsonStringify } from './db.mjs'

const coerceString = (value) => (typeof value === 'string' ? value : '')

const stripBackendTokenFromUrl = (value = '') => {
  if (!value.includes('/api/backend/image/')) return value
  return value.replace(/[?&]token=[^&]+/g, '').replace(/[?&]$/, '')
}

const sanitizeCollectionItem = (value) => {
  if (!value || typeof value !== 'object') return null
  const raw = value
  const id = coerceString(raw.id)
  if (!id) return null
  const prompt = coerceString(raw.prompt)
  const taskId = coerceString(raw.taskId)
  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : nowMs()
  const image =
    typeof raw.image === 'string' ? stripBackendTokenFromUrl(raw.image) : undefined
  const localKey = typeof raw.localKey === 'string' ? raw.localKey : undefined
  const sourceSignature =
    typeof raw.sourceSignature === 'string' ? raw.sourceSignature : undefined
  const item = { id, prompt, taskId, timestamp }
  if (image) item.image = image
  if (localKey) item.localKey = localKey
  if (sourceSignature) item.sourceSignature = sourceSignature
  return item
}

const normalizeCollectionPayload = (payload) => {
  if (!Array.isArray(payload)) return []
  const items = []
  const seen = new Set()
  payload.forEach((entry) => {
    const item = sanitizeCollectionItem(entry)
    if (!item) return
    if (seen.has(item.id)) return
    seen.add(item.id)
    items.push(item)
  })
  return items
}

export const normalizeCollectionPayloadForSave = normalizeCollectionPayload

export const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export const normalizeConcurrency = (value, fallback = DEFAULT_CONCURRENCY) =>
  clampNumber(value, MIN_CONCURRENCY, MAX_CONCURRENCY, fallback)

export const createDefaultTaskState = () => ({
  version: 1,
  prompt: '',
  concurrency: DEFAULT_CONCURRENCY,
  enableSound: true,
  results: [],
  uploads: [],
  stats: { ...DEFAULT_TASK_STATS },
})

const buildDefaultBackendState = () => {
  const config = { ...DEFAULT_BACKEND_CONFIG }
  const apiFormat =
    config.apiFormat === 'gemini' || config.apiFormat === 'vertex'
      ? config.apiFormat
      : 'openai'
  config.apiFormat = apiFormat
  const configByFormat = {
    [apiFormat]: pickFormatConfig(config),
  }
  return {
    config,
    configByFormat,
    tasksOrder: [],
    globalStats: { ...DEFAULT_GLOBAL_STATS },
  }
}

export const loadBackendState = async (userId) => {
  const db = getDb()
  const record = db.prepare('SELECT * FROM user_state WHERE user_id = ?').get(userId)
  if (!record) {
    const created = buildDefaultBackendState()
    await saveBackendState(userId, created)
    return created
  }
  const config = {
    ...DEFAULT_BACKEND_CONFIG,
    ...safeJsonParse(record.config_json, {}),
  }
  const apiFormat =
    config.apiFormat === 'gemini' || config.apiFormat === 'vertex'
      ? config.apiFormat
      : 'openai'
  config.apiFormat = apiFormat
  const configByFormat = {
    ...safeJsonParse(record.config_by_format_json, {}),
  }
  if (!configByFormat[apiFormat]) {
    configByFormat[apiFormat] = pickFormatConfig(config)
  }
  return {
    config,
    configByFormat,
    tasksOrder: safeJsonParse(record.tasks_order_json, []),
    globalStats: { ...DEFAULT_GLOBAL_STATS, ...safeJsonParse(record.global_stats_json, {}) },
  }
}

export const saveBackendState = async (userId, state) => {
  const db = getDb()
  const payload = {
    config_json: jsonStringify(state.config),
    config_by_format_json: jsonStringify(state.configByFormat || {}),
    tasks_order_json: jsonStringify(state.tasksOrder || []),
    global_stats_json: jsonStringify(state.globalStats || DEFAULT_GLOBAL_STATS),
  }
  const now = nowMs()
  const existing = db.prepare('SELECT user_id FROM user_state WHERE user_id = ?').get(userId)
  if (existing) {
    db.prepare(
      `UPDATE user_state
       SET config_json = ?, config_by_format_json = ?, tasks_order_json = ?, global_stats_json = ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(
      payload.config_json,
      payload.config_by_format_json,
      payload.tasks_order_json,
      payload.global_stats_json,
      now,
      userId,
    )
  } else {
    db.prepare(
      `INSERT INTO user_state (user_id, config_json, config_by_format_json, tasks_order_json, global_stats_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      payload.config_json,
      payload.config_by_format_json,
      payload.tasks_order_json,
      payload.global_stats_json,
      now,
    )
  }
  broadcastSseEvent('state', state, { userId })
}

export const loadBackendCollection = async (userId) => {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, prompt, task_id, timestamp, image, local_key, source_signature
       FROM collections WHERE user_id = ? ORDER BY timestamp DESC`,
    )
    .all(userId)
  return rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    taskId: row.task_id || '',
    timestamp: row.timestamp,
    image: row.image || undefined,
    localKey: row.local_key || undefined,
    sourceSignature: row.source_signature || undefined,
  }))
}

export const saveBackendCollection = async (userId, items) => {
  const db = getDb()
  const normalized = normalizeCollectionPayload(items)
  const now = nowMs()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM collections WHERE user_id = ?').run(userId)
    const insert = db.prepare(
      `INSERT INTO collections (id, user_id, prompt, task_id, timestamp, image, local_key, source_signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    normalized.forEach((item) => {
      insert.run(
        item.id,
        userId,
        item.prompt || '',
        item.taskId || '',
        item.timestamp,
        item.image || null,
        item.localKey || null,
        item.sourceSignature || null,
        now,
      )
    })
  })
  run()
}

export const loadTaskState = async (userId, taskId) => {
  const db = getDb()
  const task = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(taskId, userId)
  if (!task) return null
  const results = db
    .prepare(
      `SELECT * FROM task_results WHERE task_id = ? ORDER BY position ASC`,
    )
    .all(taskId)
    .map((row) => ({
      id: row.id,
      status: row.status,
      error: row.error || undefined,
      startTime: row.start_time || undefined,
      endTime: row.end_time || undefined,
      duration: row.duration || undefined,
      retryCount: row.retry_count || 0,
      autoRetry: Boolean(row.auto_retry),
      localKey: row.local_key || undefined,
      sourceUrl: row.source_url || undefined,
      savedLocal: Boolean(row.saved_local),
    }))
  const uploads = db
    .prepare(`SELECT * FROM uploads WHERE task_id = ? ORDER BY position ASC`)
    .all(taskId)
    .map((row) => ({
      uid: row.id,
      name: row.name || undefined,
      size: typeof row.size === 'number' ? row.size : undefined,
      type: row.type || undefined,
      localKey: row.local_key || undefined,
      lastModified: typeof row.last_modified === 'number' ? row.last_modified : undefined,
      sourceSignature: row.source_signature || undefined,
    }))
  return {
    ...createDefaultTaskState(),
    prompt: task.prompt,
    concurrency: normalizeConcurrency(task.concurrency),
    enableSound: Boolean(task.enable_sound),
    stats: { ...DEFAULT_TASK_STATS, ...safeJsonParse(task.stats_json, {}) },
    results,
    uploads,
  }
}

export const saveTaskState = async (userId, taskId, state) => {
  const db = getDb()
  const now = nowMs()
  const prompt = typeof state.prompt === 'string' ? state.prompt : ''
  const concurrency = normalizeConcurrency(state.concurrency)
  const enableSound = state.enableSound ? 1 : 0
  const statsJson = jsonStringify({ ...DEFAULT_TASK_STATS, ...(state.stats || {}) })
  const existing = db
    .prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?')
    .get(taskId, userId)
  const run = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE tasks
         SET prompt = ?, concurrency = ?, enable_sound = ?, stats_json = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).run(prompt, concurrency, enableSound, statsJson, now, taskId, userId)
    } else {
      db.prepare(
        `INSERT INTO tasks (id, user_id, prompt, concurrency, enable_sound, stats_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(taskId, userId, prompt, concurrency, enableSound, statsJson, now, now)
    }

    db.prepare('DELETE FROM task_results WHERE task_id = ?').run(taskId)
    const insertResult = db.prepare(
      `INSERT INTO task_results
       (id, task_id, position, status, error, start_time, end_time, duration, retry_count, auto_retry, local_key, source_url, saved_local, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    ;(Array.isArray(state.results) ? state.results : []).forEach((result, index) => {
      insertResult.run(
        result.id,
        taskId,
        index,
        result.status,
        result.error || null,
        result.startTime || null,
        result.endTime || null,
        result.duration || null,
        result.retryCount || 0,
        result.autoRetry === false ? 0 : 1,
        result.localKey || null,
        result.sourceUrl || null,
        result.savedLocal ? 1 : 0,
        now,
      )
    })

    db.prepare('DELETE FROM uploads WHERE task_id = ?').run(taskId)
    const insertUpload = db.prepare(
      `INSERT INTO uploads
       (id, task_id, position, name, size, type, local_key, last_modified, source_signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    ;(Array.isArray(state.uploads) ? state.uploads : []).forEach((upload, index) => {
      const uploadId =
        upload?.uid ||
        upload?.id ||
        crypto.randomUUID()
      insertUpload.run(
        uploadId,
        taskId,
        index,
        upload.name || null,
        typeof upload.size === 'number' ? upload.size : null,
        upload.type || null,
        upload.localKey || null,
        typeof upload.lastModified === 'number' ? upload.lastModified : null,
        upload.sourceSignature || null,
        now,
      )
    })
  })
  run()
  broadcastSseEvent('task', { taskId, state }, { userId })
}
