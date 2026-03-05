import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { getDb } from './db.mjs'

const captchaStore = new Map()

const normalizeText = (value) => String(value || '').trim().toLowerCase()

export const createCaptcha = (text, ttlMs = 2 * 60 * 1000) => {
  const id = crypto.randomUUID()
  const record = {
    id,
    text: String(text || ''),
    expiresAt: Date.now() + Math.max(1000, ttlMs),
  }
  captchaStore.set(id, record)
  return record
}

export const cleanupExpiredCaptcha = () => {
  const now = Date.now()
  for (const [id, record] of captchaStore.entries()) {
    if (!record || record.expiresAt <= now) {
      captchaStore.delete(id)
    }
  }
}

export const verifyCaptcha = (id, code) => {
  if (!id) return false
  const record = captchaStore.get(id)
  if (!record) return false
  if (Date.now() > record.expiresAt) {
    captchaStore.delete(id)
    return false
  }
  const ok = normalizeText(code) === normalizeText(record.text)
  if (ok) {
    captchaStore.delete(id)
  }
  return ok
}

export const getUserByUsername = (username) => {
  const name = String(username || '').trim()
  if (!name) return null
  const db = getDb()
  return db.prepare('SELECT * FROM users WHERE username = ?').get(name) || null
}

export const listUsers = () => {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, username, role, disabled, created_at, last_login_at
       FROM users
       ORDER BY created_at DESC`,
    )
    .all()
}

export const verifyPassword = async (password, hash) => {
  if (!hash) return false
  return bcrypt.compare(String(password || ''), String(hash))
}

export const createUser = async ({ username, password, role = 'user' }) => {
  const name = String(username || '').trim()
  const pwd = String(password || '')
  if (!name) {
    throw new Error('用户名不能为空')
  }
  if (!pwd) {
    throw new Error('密码不能为空')
  }
  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name)
  if (existing) {
    throw new Error('用户名已存在')
  }
  const hash = await bcrypt.hash(pwd, 10)
  const now = Date.now()
  const id = crypto.randomUUID()
  const normalizedRole = role === 'admin' ? 'admin' : 'user'
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, disabled, created_at, last_login_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL)`,
  ).run(id, name, hash, normalizedRole, now)
  return { id, username: name, role: normalizedRole, created_at: now, last_login_at: null }
}

export const updateLastLogin = (userId) => {
  if (!userId) return
  const db = getDb()
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId)
}

export const ensureBootstrapAdmin = async ({ username, password }) => {
  const name = String(username || '').trim()
  const pwd = String(password || '')
  if (!name || !pwd) return
  const existing = getUserByUsername(name)
  if (existing) return
  await createUser({ username: name, password: pwd, role: 'admin' })
}
