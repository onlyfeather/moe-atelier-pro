import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { backendImagesDir, saveDir } from './config.mjs'

export const getExtensionFromType = (contentType = '') => {
  const normalized = contentType.toLowerCase()
  const mapping = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  }
  const matched = Object.keys(mapping).find((key) => normalized.includes(key))
  return matched ? mapping[matched] : '.bin'
}

const findExistingFile = async (dir, hash) => {
  try {
    const files = await fs.promises.readdir(dir)
    return files.find((name) => name.startsWith(hash)) || null
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

export const saveImageBuffer = async (buffer, contentType) => {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = getExtensionFromType(contentType)
  const fileName = `${fileHash}${extension}`
  const filePath = path.join(saveDir, fileName)

  await fs.promises.mkdir(saveDir, { recursive: true })
  const matched = await findExistingFile(saveDir, fileHash)
  if (matched) {
    return { saved: false, exists: true, fileName: matched }
  }

  await fs.promises.writeFile(filePath, buffer)
  return { saved: true, exists: false, fileName }
}

export const saveBackendImageBuffer = async (userId, buffer, contentType) => {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = getExtensionFromType(contentType)
  const fileName = `${fileHash}${extension}`
  const userDir = path.join(backendImagesDir, String(userId))
  const filePath = path.join(userDir, fileName)

  await fs.promises.mkdir(userDir, { recursive: true })
  const matched = await findExistingFile(userDir, fileHash)
  if (matched) {
    return { saved: false, exists: true, fileName: matched }
  }

  await fs.promises.writeFile(filePath, buffer)
  return { saved: true, exists: false, fileName }
}

export const getBackendImagePath = (userId, fileName) => {
  const safeName = path.basename(String(fileName || ''))
  const safeUser = path.basename(String(userId || ''))
  if (!safeName || !safeUser) return ''
  return path.join(backendImagesDir, safeUser, safeName)
}

export const getMimeFromFilename = (fileName = '') => {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}
