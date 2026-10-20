const TOKEN_KEY = 'neighbor.token';
const USER_KEY = 'neighbor.user';

export class ApiError extends Error {
  constructor(status, detail, traceId) {
    const message = typeof detail === 'string'
      ? detail
      : detail?.message || detail?.detail || `请求失败（${status}）`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = detail?.code || 'HTTP_ERROR';
    this.fields = detail?.fields || [];
    this.detail = detail;
    this.traceId = detail?.trace_id || traceId;
  }
}

export const session = {
  token: localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '',
  persistent: Boolean(localStorage.getItem(TOKEN_KEY)),
  user: (() => {
    try {
      const raw = localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY) || 'null';
      return JSON.parse(raw);
    } catch { return null; }
  })(),
};

export function saveSession(token, user, persistent = true) {
  session.token = token;
  session.user = user;
  session.persistent = persistent;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  const storage = persistent ? localStorage : sessionStorage;
  storage.setItem(TOKEN_KEY, token);
  storage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  session.token = '';
  session.user = null;
  session.persistent = false;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

function authHeaders() {
  return session.token ? { Authorization: `Bearer ${session.token}` } : {};
}

async function request(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const options = {
    method,
    headers: { Accept: 'application/json', ...authHeaders(), ...headers },
    signal,
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: '无法连接服务，请确认后端已启动后重试。' });
  }
  if (raw) {
    if (!response.ok) {
      let detail = null;
      try { detail = (await response.json()).detail; } catch { /* ignore */ }
      throw new ApiError(response.status, detail, response.headers.get('x-trace-id'));
    }
    return response;
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { detail: text }; }
  }
  if (!response.ok) {
    if (response.status === 401 && session.token) {
      clearSession();
      window.dispatchEvent(new CustomEvent('session:expired'));
    }
    throw new ApiError(response.status, payload?.detail || payload, response.headers.get('x-trace-id'));
  }
  return payload;
}

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const api = {
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  demoAccounts: () => request('/api/auth/demo-accounts'),
  me: () => request('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  meta: () => request('/api/meta'),
  health: () => request('/api/health'),

  dashboard: () => request('/api/dashboard'),
  report: (days = 7) => request(`/api/reports/operations${query({ days })}`),

  communities: () => request('/api/communities'),
  createCommunity: (body) => request('/api/communities', { method: 'POST', body }),

  piles: (params = {}) => request(`/api/piles${query(params)}`),
  pile: (id) => request(`/api/piles/${encodeURIComponent(id)}`),
  createPile: (body) => request('/api/piles', { method: 'POST', body }),

  reservations: () => request('/api/reservations'),
  createReservation: (body) => request('/api/reservations', {
    method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey() },
  }),
  cancelReservation: (id) => request(`/api/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', body: { reason: '用户取消预约' },
  }),

  orders: (params = {}) => request(`/api/orders${query(params)}`),
  order: (id) => request(`/api/orders/${encodeURIComponent(id)}`),
  startOrder: (id) => request(`/api/orders/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  completeOrder: (id, body) => request(`/api/orders/${encodeURIComponent(id)}/complete`, { method: 'POST', body }),
  cancelOrder: (id, reason = '用户取消') => request(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason } }),
  requestRefund: (body) => request('/api/refunds', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey() } }),

  events: (limit = 80) => request(`/api/events${query({ limit })}`),
  ingestEvent: (body) => request('/api/device-events', { method: 'POST', body }),

  tickets: (params = {}) => request(`/api/tickets${query(params)}`),
  ticket: (id) => request(`/api/tickets/${encodeURIComponent(id)}`),
  createTicket: (body) => request('/api/tickets', { method: 'POST', body }),
  assignTicket: (id, assigneeId) => request(`/api/tickets/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { assignee_id: assigneeId } }),
  acceptTicket: (id) => request(`/api/tickets/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  resolveTicket: (id, resolution) => request(`/api/tickets/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { resolution } }),
  createTestOrder: (id, kwh = 0.5) => request(`/api/tickets/${encodeURIComponent(id)}/test-order`, { method: 'POST', body: { kwh } }),
  heartbeat: (id) => request(`/api/tickets/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' }),
  closeTicket: (id) => request(`/api/tickets/${encodeURIComponent(id)}/close`, { method: 'POST' }),
  assignees: () => request('/api/assignees'),

  approvals: (params = {}) => request(`/api/approvals${query(params)}`),
  approval: (id) => request(`/api/approvals/${encodeURIComponent(id)}`),
  createApproval: (body) => request('/api/approvals', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey() } }),
  decideApproval: (id, approved, comment) => request(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: 'POST', body: { approved, comment },
  }),

  users: (params = {}) => request(`/api/users${query(params)}`),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  setUserStatus: (id, status) => request(`/api/users/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } }),

  audit: (params = {}) => request(`/api/audit${query(params)}`),

  agentChat: (message, threadId) => request('/api/agent/chat', { method: 'POST', body: { message, thread_id: threadId || undefined } }),
  agentThreads: () => request('/api/agent/threads'),
  agentPolicy: () => request('/api/agent/policy'),

  async downloadReport(days = 7) {
    const response = await request(`/api/reports/operations.csv${query({ days })}`, { raw: true });
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/);
    const name = match?.[1] || `neighbor-charge-report-${days}d.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
