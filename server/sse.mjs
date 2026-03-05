const sseClients = new Map()

export const sendSseEvent = (res, event, data) => {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export const addSseClient = (res, meta = {}) => {
  sseClients.set(res, {
    userId: meta.userId || '',
    isAdmin: Boolean(meta.isAdmin),
  })
}

export const removeSseClient = (res) => {
  sseClients.delete(res)
}

export const broadcastSseEvent = (event, data, { userId } = {}) => {
  for (const [res, meta] of sseClients.entries()) {
    if (userId && !meta.isAdmin && meta.userId !== userId) {
      continue
    }
    try {
      sendSseEvent(res, event, data)
    } catch (_err) {
      sseClients.delete(res)
    }
  }
}
