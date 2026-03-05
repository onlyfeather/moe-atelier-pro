import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { dbPath } from './config.mjs'

let dbInstance = null

const ensureDbDir = () => {
  const dir = path.dirname(dbPath)
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
}

const getTableColumns = (db, table) => {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  } catch {
    return []
  }
}

const hasColumn = (db, table, column) => getTableColumns(db, table).includes(column)

const ensureColumn = (db, table, column, definition) => {
  if (hasColumn(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

const renameColumn = (db, table, from, to) => {
  if (!hasColumn(db, table, from)) return
  if (hasColumn(db, table, to)) return
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
}

const migrate = (db) => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY,
      config_json TEXT,
      config_by_format_json TEXT,
      tasks_order_json TEXT,
      global_stats_json TEXT,
      updated_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      prompt TEXT,
      concurrency INTEGER NOT NULL DEFAULT 2,
      enable_sound INTEGER NOT NULL DEFAULT 1,
      stats_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_results (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      error TEXT,
      retry_count INTEGER,
      start_time INTEGER,
      end_time INTEGER,
      duration INTEGER,
      local_key TEXT,
      source_url TEXT,
      saved_local INTEGER,
      auto_retry INTEGER,
      created_at INTEGER,
      PRIMARY KEY (task_id, id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS uploads (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      type TEXT,
      size INTEGER,
      last_modified INTEGER,
      local_key TEXT,
      from_collection INTEGER,
      source_signature TEXT,
      created_at INTEGER,
      PRIMARY KEY (task_id, id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collections (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      prompt TEXT,
      task_id TEXT,
      timestamp INTEGER,
      image TEXT,
      local_key TEXT,
      source_signature TEXT,
      created_at INTEGER,
      PRIMARY KEY (user_id, id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS global_config (
      id INTEGER PRIMARY KEY,
      api_key TEXT,
      api_url TEXT,
      api_format TEXT,
      api_version TEXT,
      vertex_project_id TEXT,
      vertex_location TEXT,
      vertex_publisher TEXT,
      model_whitelist_json TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS model_cache (
      id TEXT PRIMARY KEY,
      api_format TEXT,
      api_url TEXT,
      api_version TEXT,
      models_json TEXT,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_results_task ON task_results(task_id);
    CREATE INDEX IF NOT EXISTS idx_uploads_task ON uploads(task_id);
    CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);
  `)

  renameColumn(db, 'uploads', 'uid', 'id')
  ensureColumn(db, 'tasks', 'concurrency', 'concurrency INTEGER NOT NULL DEFAULT 2')
  ensureColumn(db, 'tasks', 'enable_sound', 'enable_sound INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'tasks', 'stats_json', 'stats_json TEXT')
  ensureColumn(db, 'tasks', 'created_at', 'created_at INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'tasks', 'updated_at', 'updated_at INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'task_results', 'position', 'position INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'task_results', 'created_at', 'created_at INTEGER')
  ensureColumn(db, 'uploads', 'position', 'position INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'uploads', 'created_at', 'created_at INTEGER')
  ensureColumn(db, 'collections', 'created_at', 'created_at INTEGER')
}

const initDb = () => {
  ensureDbDir()
  const db = new Database(dbPath)
  migrate(db)
  return db
}

export const getDb = () => {
  if (!dbInstance) {
    dbInstance = initDb()
  }
  return dbInstance
}

export const safeJsonParse = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export const jsonStringify = (value, fallback = '{}') => {
  try {
    return JSON.stringify(value ?? safeJsonParse(fallback, {}))
  } catch {
    return fallback
  }
}

export const nowMs = () => Date.now()
