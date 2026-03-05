export interface AdminUser {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: number
  created_at: number
  last_login_at: number | null
}

export interface AdminConfig {
  apiKey: string
  apiUrl: string
  apiFormat: 'openai' | 'gemini' | 'vertex'
  apiVersion: string
  vertexProjectId: string
  vertexLocation: string
  vertexPublisher: string
  modelWhitelist: string[]
}

export interface AdminTaskRow {
  id: string
  user_id: string
  username: string
  prompt?: string
  created_at?: number
  updated_at?: number
}

export interface AdminTaskDetail {
  user: { id: string; username: string }
  task: any
}

const adminFetch = async (path: string, options: RequestInit = {}) => {
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

const adminJson = async <T>(path: string, options: RequestInit = {}) => {
  const response = await adminFetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    const error = new Error(text || response.statusText)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return (await response.json()) as T
}

export const fetchAdminUsers = async () => adminJson<AdminUser[]>('/api/admin/users', { method: 'GET' })

export const createAdminUser = async (payload: {
  username: string
  password: string
  role?: 'admin' | 'user'
}) =>
  adminJson<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const fetchAdminConfig = async () => adminJson<AdminConfig>('/api/admin/config', { method: 'GET' })

export const updateAdminConfig = async (payload: Partial<AdminConfig>) =>
  adminJson<AdminConfig>('/api/admin/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })

export const fetchAdminSummary = async () =>
  adminJson<{ users: number; tasks: number; stats: any }>('/api/admin/summary', { method: 'GET' })

export const fetchAdminTasks = async (userId?: string) => {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : ''
  try {
    return await adminJson<AdminTaskRow[]>(`/api/admin/tasks${query}`, { method: 'GET' })
  } catch (err: any) {
    if (err?.status === 404) {
      return adminJson<AdminTaskRow[]>(`/api/admin/task${query}`, { method: 'GET' })
    }
    throw err
  }
}

export const fetchAdminTaskDetail = async (taskId: string) =>
  adminJson<AdminTaskDetail>(`/api/admin/task/${encodeURIComponent(taskId)}`, { method: 'GET' })
