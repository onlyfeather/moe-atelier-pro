import fs from 'node:fs'
import path from 'node:path'

export const rootDir = process.cwd()

const loadEnvFile = () => {
  const envPath = path.join(rootDir, '.env')
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf-8')
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) return
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  })
}

loadEnvFile()

export const isProd = process.argv.includes('--prod')
export const port = Number(process.env.PORT) || 5173
export const saveDir = path.resolve(rootDir, 'saved-images')
export const distDir = path.resolve(rootDir, 'dist')
export const serverDataDir = path.resolve(rootDir, 'server-data')
export const backendTasksDir = path.join(serverDataDir, 'tasks')
export const backendImagesDir = path.join(serverDataDir, 'images')
export const backendStatePath = path.join(serverDataDir, 'state.json')
export const backendCollectionPath = path.join(serverDataDir, 'collection.json')
export const dbPath = path.join(serverDataDir, 'app.db')
export const backendLogResponse = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_RESPONSE || '').toLowerCase(),
)
export const backendLogRequests = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_REQUESTS || '').toLowerCase(),
)
export const backendLogOutbound = ['1', 'true', 'yes'].includes(
  String(process.env.BACKEND_LOG_OUTBOUND || '').toLowerCase(),
)

export const sessionSecret = process.env.SESSION_SECRET || ''
export const sessionTtlSeconds = Number(process.env.SESSION_TTL || 60 * 60 * 24 * 7)
export const adminBootstrapUsername = process.env.ADMIN_USERNAME || ''
export const adminBootstrapPassword = process.env.ADMIN_PASSWORD || ''

export const DEFAULT_BACKEND_CONFIG = {
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  apiFormat: 'openai',
  apiVersion: 'v1',
  vertexProjectId: '',
  vertexLocation: 'us-central1',
  vertexPublisher: 'google',
  stream: false,
  enableCollection: false,
}

export const FORMAT_CONFIG_KEYS = [
  'apiUrl',
  'apiKey',
  'model',
  'apiVersion',
  'vertexProjectId',
  'vertexLocation',
  'vertexPublisher',
  'thinkingBudget',
  'includeThoughts',
  'includeImageConfig',
  'includeSafetySettings',
  'safety',
  'imageConfig',
  'webpQuality',
  'useResponseModalities',
  'customJson',
]

export const pickFormatConfig = (config = {}) => {
  const next = {}
  FORMAT_CONFIG_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      next[key] = config[key]
    }
  })
  return next
}

export const DEFAULT_GLOBAL_STATS = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
}

export const DEFAULT_TASK_STATS = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
}

export const MIN_CONCURRENCY = 1
export const DEFAULT_CONCURRENCY = 2
export const MAX_CONCURRENCY = Number.POSITIVE_INFINITY

export const BACKEND_LOG_MAX_CHARS = 800
