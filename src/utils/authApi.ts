export interface AuthUser {
  id: string
  username: string
  role: 'admin' | 'user'
}

export interface CaptchaResponse {
  id: string
  svg: string
}

const authFetch = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
  })
  return response
}

const authJson = async <T>(path: string, options: RequestInit = {}) => {
  const response = await authFetch(path, {
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

export const fetchCaptcha = async () => authJson<CaptchaResponse>('/api/auth/captcha', { method: 'GET' })

export const login = async (payload: {
  username: string
  password: string
  captchaId: string
  captchaCode: string
}) =>
  authJson<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const logout = async () =>
  authJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })

export const fetchMe = async () => authJson<{ user: AuthUser }>('/api/auth/me', { method: 'GET' })
