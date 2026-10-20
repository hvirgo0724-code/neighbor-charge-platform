/**
 * 邻里充电运营平台 · Netlify Function（自包含 JavaScript 适配层）
 *
 * Netlify Functions 只官方支持 JS/TS 与 Go，因此线上演示不再运行 FastAPI，
 * 而由本文件复刻 app/services.py、app/agent.py 与 app/routers/* 的接口契约：
 *   - 状态保存在模块级内存（冷启动时深拷贝同目录 seed.mjs）
 *   - 仅使用 Node 内置模块，无 npm 依赖
 *   - 认证：HMAC-SHA256 签名令牌 + 内存吊销 + 登录限流
 *   - 响应：JSON 错误统一为 {detail:{code,message,trace_id,...}}
 *
 * 真正的后端仍是 FastAPI（本地/Docker），本文件只服务 Netlify 一键部署。
 */
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import seedData from './seed.mjs';

const SEED = seedData;
const state = JSON.parse(JSON.stringify(SEED)); // 冷启动深拷贝，seed 本身只读
const STARTED_AT = Date.now();
const ALS = new AsyncLocalStorage();
const traceId = () => ALS.getStore()?.trace || '-';
const currentOrigin = () => ALS.getStore()?.origin || '*';

// ---------------------------------------------------------------- constants
const APP_NAME = '邻里充电运营平台';
const APP_VERSION = '1.0.0';
const DEMO_MODE = String(process.env.DEMO_MODE ?? 'true').toLowerCase() !== 'false';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'neighbor-charge-demo-secret-change-me';
const TOKEN_TTL = clampInt(process.env.TOKEN_TTL_SECONDS, 8 * 3600, 300, 7 * 24 * 3600);
const HEARTBEAT_FRESH_MINUTES = clampInt(process.env.HEARTBEAT_FRESH_MINUTES, 10, 1, 180);
const MAX_RESERVATION_HOURS = clampInt(process.env.MAX_RESERVATION_HOURS, 4, 1, 12);
const LOGIN_MAX_ATTEMPTS = clampInt(process.env.LOGIN_MAX_ATTEMPTS, 6, 3, 20);
const LOGIN_WINDOW_SECONDS = clampInt(process.env.LOGIN_WINDOW_SECONDS, 300, 60, 3600);
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || 'demo-device-key-change-me';
const ROLE_LABELS = { admin: '系统管理员', operator: '运营人员', repairer: '维修人员', finance: '财务审批', user: '居民用户' };
const PILE_STATUS_LABELS = { available: '可用', charging: '充电中', reserved: '已预约', fault: '故障', offline: '离线', maintenance: '维护中' };
const TICKET_STATUS_LABELS = { open: '待处理', assigned: '已分派', processing: '处理中', pending_acceptance: '待验收', closed: '已关闭' };
const ORDER_STATUS_LABELS = { reserved: '已预约', charging: '充电中', completed: '已完成', cancelled: '已取消', refunded: '已退款', pending_payment: '待支付', exception: '异常' };
const ORDER_ACTIVE = new Set(['reserved', 'charging']);
const PILE_BLOCKED = new Set(['fault', 'offline', 'maintenance']);
const TICKET_OPEN = new Set(['open', 'assigned', 'processing', 'pending_acceptance']);
const LEVEL_HOURS = { P1: 2, P2: 8, P3: 24 };
const HIGH_RISK_WORDS = ['退款', '停机', '下线', '调价', '改价', '价格调整', '批量改派', '批量'];
const FAULT_WORDS = ['故障', '异常', '维修', '离线', '告警', '中断', '温度'];
const AVAILABLE_WORDS = ['可用', '空闲', '能充', '充电桩', '空闲桩'];
const REVENUE_WORDS = ['收入', '营收', '订单', '流水', '退款金额', '客单价'];
const TICKET_WORDS = ['工单', '维修进度', '超时'];
const APPROVAL_WORDS = ['审批', '待办', '待审批'];
const METRIC_WORDS = ['可用率', '利用率', '指标', '修复时长', 'mttr', '预约成功率', '健康度'];
const PRICE_WORDS = ['电价', '服务费', '价格', '多少钱'];
const CREATE_TICKET_WORDS = ['创建工单', '报修', '生成工单', '建工单'];

// --------------------------------------------------------------- primitives
function clampInt(raw, fallback, low, high) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(low, Math.min(high, parsed));
}
function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
const money = (value) => round(Number(value || 0), 2);
function pct(part, total, digits = 1) {
  if (!total) return 0;
  return round((part / total) * 100, digits);
}
function iso(value = new Date()) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function parseDt(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value).replace('Z', '+00:00'));
  return Number.isNaN(date.getTime()) ? null : date;
}
function minutesSince(value) {
  const date = parseDt(value);
  return date ? (Date.now() - date.getTime()) / 60000 : null;
}
function startOfDay(daysAgo = 0) {
  const cnNow = Date.now() + 8 * 3600 * 1000;
  const day = Math.floor(cnNow / 86400000) - daysAgo;
  return new Date(day * 86400000 - 8 * 3600 * 1000);
}
function cnDateKey(value) {
  const date = parseDt(value);
  if (!date) return '';
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function dateRange(days) {
  const today = new Date(Date.now() + 8 * 3600 * 1000);
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  const leftA = parseDt(aStart), rightA = parseDt(aEnd), leftB = parseDt(bStart), rightB = parseDt(bEnd);
  if (!leftA || !rightA || !leftB || !rightB) return false;
  return leftA < rightB && leftB < rightA;
}
function sortDesc(items, key = 'created_at') {
  return [...items].sort((a, b) => {
    const left = parseDt(a[key])?.getTime() ?? -8640000000000000;
    const right = parseDt(b[key])?.getTime() ?? -8640000000000000;
    return right - left;
  });
}
function sanitizeText(value) {
  let text = String(value ?? '');
  text = text.replace(/([\w.+-]{1,2})[\w.+-]*(@[\w.-]+)/g, '$1***$2');
  text = text.replace(/\b(\d{3})\d{11}(\d{3}[\dXx])\b/g, '$1***********$2');
  text = text.replace(/(password|passwd|token|secret)\s*[=:]\s*\S+/gi, '$1=***');
  return text;
}
function maskPhone(value) {
  if (!value) return '';
  return String(value).replace(/(\d{3})\d{4}(\d{4})/g, '$1****$2');
}
function fmt2(value) {
  return money(value).toFixed(2);
}
function nextId(collection, prefix, width = 4) {
  let highest = 0;
  for (const key of Object.keys(state[collection] || {})) {
    const digits = (key.match(/\d+/g) || []).join('');
    if (digits) highest = Math.max(highest, Number.parseInt(digits, 10));
  }
  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}
function b64url(raw) {
  return Buffer.from(raw).toString('base64url');
}

// ------------------------------------------------------------------- errors
class ApiError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
  detail() {
    return { code: this.code, message: this.message, trace_id: traceId(), ...this.extra };
  }
}
const badRequest = (message, code = 'BAD_REQUEST', extra = {}) => new ApiError(400, code, message, extra);
const unauthorized = (message = '请先登录', code = 'UNAUTHORIZED') => new ApiError(401, code, message, {}, { 'www-authenticate': 'Bearer' });
const forbidden = (message = '当前角色无权执行该操作', code = 'FORBIDDEN') => new ApiError(403, code, message);
const notFound = (message = '资源不存在', code = 'NOT_FOUND') => new ApiError(404, code, message);
const conflict = (message, code = 'CONFLICT', extra = {}) => new ApiError(409, code, message, extra);
const unprocessable = (message, fields = []) => new ApiError(422, 'VALIDATION_ERROR', message, { fields });
const tooMany = (message, retryAfter) => new ApiError(429, 'RATE_LIMITED', message, { retry_after: retryAfter }, { 'retry-after': String(retryAfter) });
function fieldError(field, message) {
  return unprocessable('请求参数校验失败', [{ field, message, type: 'value_error' }]);
}
function need(cond, field, message) {
  if (!cond) throw fieldError(field, message);
}
function needText(value, field, { min = 0, max = Infinity } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  need(text.length >= min && text.length <= max, field, `长度需在 ${min} 至 ${max === Infinity ? '不限' : max} 个字符之间`);
  return text;
}
function asNumber(value, field) {
  const parsed = Number(value);
  need(Number.isFinite(parsed), field, '必须是数字');
  return parsed;
}
function asList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

// ------------------------------------------------------------------- tokens
const REVOKED = new Map();
const LOGIN_ATTEMPTS = new Map();

function signToken(segment) {
  return crypto.createHmac('sha256', JWT_SECRET).update(segment).digest('base64url');
}
function issueToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id, tenant_id: user.tenant_id, role: user.role, name: user.display_name,
    jti: crypto.randomUUID().replace(/-/g, ''), iat: issuedAt, exp: issuedAt + TOKEN_TTL,
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const segment = `${head}.${body}`;
  return { token: `${segment}.${signToken(segment)}`, ttl: TOKEN_TTL, jti: payload.jti, exp: payload.exp };
}
function decodeToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('format');
    const segment = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(signToken(segment));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('signature');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || !payload.sub || !payload.exp) throw new Error('payload');
    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) throw new Error('expired');
    const revoked = REVOKED.get(payload.jti);
    if (revoked) throw new Error('revoked');
    return payload;
  } catch {
    throw unauthorized('登录已失效，请重新登录', 'TOKEN_INVALID');
  }
}
function revokeToken(jti, exp) {
  if (!jti) return;
  REVOKED.set(jti, Number(exp || Math.floor(Date.now() / 1000) + 60));
  const nowSeconds = Date.now() / 1000;
  for (const [key, deadline] of REVOKED) {
    if (deadline < nowSeconds) REVOKED.delete(key);
  }
}
function checkLoginRate(key) {
  const cutoff = Date.now() / 1000 - LOGIN_WINDOW_SECONDS;
  const attempts = (LOGIN_ATTEMPTS.get(key) || []).filter((at) => at > cutoff);
  LOGIN_ATTEMPTS.set(key, attempts);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    const retry = Math.max(1, Math.round(LOGIN_WINDOW_SECONDS - (Date.now() / 1000 - attempts[0])));
    throw tooMany(`登录尝试过多，请在 ${retry} 秒后重试`, retry);
  }
}
function recordLoginFailure(key) {
  const list = LOGIN_ATTEMPTS.get(key) || [];
  list.push(Date.now() / 1000);
  LOGIN_ATTEMPTS.set(key, list);
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  try {
    const [algorithm, iterations, salt, encoded] = String(stored).split('$');
    if (algorithm !== 'pbkdf2_sha256') return false;
    const digest = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, 'sha256').toString('base64');
    const left = Buffer.from(digest);
    const right = Buffer.from(encoded);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(String(password), salt, 260000, 32, 'sha256').toString('base64');
  return `pbkdf2_sha256$260000$${salt}$${digest}`;
}
function publicUser(user) {
  return {
    id: user.id, tenant_id: user.tenant_id, username: user.username,
    display_name: user.display_name, role: user.role,
    community_ids: [...(user.community_ids || [])],
    phone: maskPhone(user.phone || ''), email: user.email || '',
    status: user.status || 'active', created_at: user.created_at ?? null,
    last_login_at: user.last_login_at ?? null,
  };
}
function identityFromToken(payload) {
  const user = state.users[payload.sub];
  if (!user) throw unauthorized('账号不存在或已被删除', 'USER_NOT_FOUND');
  if (user.status !== 'active') throw unauthorized('账号已被停用，请联系管理员', 'USER_DISABLED');
  return { ...publicUser(user), jti: payload.jti, token_exp: payload.exp };
}
function currentUser(req) {
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) throw unauthorized();
  return identityFromToken(decodeToken(header.slice(7).trim()));
}
function requestIp(req) {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return (req.headers.get('x-nf-client-connection-ip') || 'unknown').slice(0, 64);
}

// ------------------------------------------------------------------- scoping
const isAdmin = (user) => user.role === 'admin';
const isStaff = (user) => ['admin', 'operator', 'repairer'].includes(user.role);
const canManage = (user) => ['admin', 'operator'].includes(user.role);
const canApprove = (user) => ['admin', 'finance'].includes(user.role);

function scopedCommunities(user) {
  if (isAdmin(user) || user.role === 'finance') {
    return Object.values(state.communities).filter((item) => item.tenant_id === user.tenant_id).map((item) => item.id);
  }
  return [...(user.community_ids || [])];
}
function ensureTenantRecord(user, record, label = '资源') {
  if (record.tenant_id !== user.tenant_id) throw forbidden(`无权访问该${label}`);
}
function ensureCommunity(user, communityId) {
  const community = state.communities[communityId];
  if (!community || community.tenant_id !== user.tenant_id) throw forbidden('无权访问该社区的数据');
  if (!scopedCommunities(user).includes(communityId)) throw forbidden('该社区不在你的数据授权范围内');
}
function ensurePileScope(user, pile) {
  ensureTenantRecord(user, pile, '充电桩');
  if (!scopedCommunities(user).includes(pile.community_id)) throw forbidden('该设备不在你的数据授权范围内');
}
function ensureOrderScope(user, order) {
  ensureTenantRecord(user, order, '订单');
  if (user.role === 'user' && order.user_id !== user.id) throw forbidden('只能访问本人的订单');
  if (!['user', 'admin', 'finance'].includes(user.role) && !scopedCommunities(user).includes(order.community_id)) {
    throw forbidden('该订单不在你的数据授权范围内');
  }
}
function ensureTicketScope(user, ticket) {
  ensureTenantRecord(user, ticket, '工单');
  if (user.role === 'user') {
    if (ticket.reporter_id !== user.id) throw forbidden('只能访问本人提交的工单');
  } else if (!scopedCommunities(user).includes(ticket.community_id)) {
    throw forbidden('该工单不在你的数据授权范围内');
  }
}
function ensureApprovalScope(user, approval) {
  ensureTenantRecord(user, approval, '审批');
  const payload = approval.payload || {};
  if (user.role === 'user' && approval.requester_id !== user.id) throw forbidden('只能查看本人的申请');
  if (!canApprove(user) && user.role !== 'admin') {
    const communities = new Set(scopedCommunities(user));
    if (payload.community_id && !communities.has(payload.community_id)) throw forbidden('该审批不在你的数据授权范围内');
    if (payload.pile_id && !communities.has(state.piles[payload.pile_id]?.community_id)) throw forbidden('该审批不在你的数据授权范围内');
    if (payload.order_id && !communities.has(state.orders[payload.order_id]?.community_id)) throw forbidden('该审批不在你的数据授权范围内');
  }
}
function getOrder(orderId) {
  const order = state.orders[orderId];
  if (!order) throw notFound('订单不存在');
  return order;
}
function getPile(pileId) {
  const pile = state.piles[pileId];
  if (!pile) throw notFound('充电桩不存在');
  return pile;
}
function getTicket(ticketId) {
  const ticket = state.tickets[ticketId];
  if (!ticket) throw notFound('工单不存在');
  return ticket;
}
function getUser(userId) {
  const user = state.users[userId];
  if (!user) throw notFound('用户不存在');
  return user;
}
function ordersFor(user) {
  const communities = new Set(scopedCommunities(user));
  return Object.values(state.orders).filter((order) => {
    if (order.tenant_id !== user.tenant_id) return false;
    if (user.role === 'user') return order.user_id === user.id;
    return communities.has(order.community_id);
  });
}
function pilesFor(user) {
  const communities = new Set(scopedCommunities(user));
  return Object.values(state.piles).filter((pile) => pile.tenant_id === user.tenant_id && communities.has(pile.community_id));
}
function ticketsFor(user) {
  const communities = new Set(scopedCommunities(user));
  return Object.values(state.tickets).filter((ticket) => {
    if (ticket.tenant_id !== user.tenant_id) return false;
    if (user.role === 'user') return ticket.reporter_id === user.id;
    return communities.has(ticket.community_id);
  });
}
function approvalsFor(user) {
  const communities = new Set(scopedCommunities(user));
  return Object.values(state.approvals).filter((approval) => {
    if (approval.tenant_id !== user.tenant_id) return false;
    if (user.role === 'user' && approval.requester_id !== user.id) return false;
    if (user.role === 'operator') {
      const payload = approval.payload || {};
      let belongs = approval.requester_id === user.id;
      if (payload.community_id && communities.has(payload.community_id)) belongs = true;
      if (payload.pile_id && communities.has(state.piles[payload.pile_id]?.community_id)) belongs = true;
      if (payload.order_id && communities.has(state.orders[payload.order_id]?.community_id)) belongs = true;
      if (!belongs) return false;
    }
    return true;
  });
}

// --------------------------------------------------------------- projections
function communityPublic(community) {
  const piles = Object.values(state.piles).filter((pile) => pile.community_id === community.id);
  const org = state.orgs[community.org_id] || {};
  const active = piles.filter((pile) => !PILE_BLOCKED.has(pile.status));
  return {
    ...community,
    org_name: org.name || '',
    pile_count: piles.length,
    available_count: piles.filter((pile) => pile.status === 'available').length,
    charging_count: piles.filter((pile) => pile.status === 'charging').length,
    fault_count: piles.filter((pile) => ['fault', 'offline'].includes(pile.status)).length,
    availability_rate: pct(active.length, piles.length),
    total_power: round(piles.reduce((sum, pile) => sum + Number(pile.power), 0), 1),
    open_tickets: Object.values(state.tickets).filter((ticket) => ticket.community_id === community.id && TICKET_OPEN.has(ticket.status)).length,
  };
}
function pilePublic(pile) {
  const community = state.communities[pile.community_id] || {};
  const active = Object.values(state.orders).find((order) => order.pile_id === pile.id && ORDER_ACTIVE.has(order.status));
  return {
    ...pile,
    community_name: community.name || '',
    last_seen_minutes: round(minutesSince(pile.last_seen) || 999, 1),
    available_now: pile.status === 'available',
    active_order: active ? { id: active.id, status: active.status, user_id: active.user_id, ends_at: active.reserved_end ?? null } : null,
  };
}
function orderPublic(order, viewer = null) {
  const pile = state.piles[order.pile_id] || {};
  const community = state.communities[order.community_id] || {};
  const owner = state.users[order.user_id] || {};
  const canOperate = Boolean(viewer && (isStaff(viewer) || viewer.id === order.user_id));
  const remaining = money(Number(order.amount || 0) - Number(order.refund_amount || 0));
  return {
    ...order,
    pile_code: pile.code || '',
    pile_power: pile.power || 0,
    community_name: community.name || '',
    user_name: owner.display_name || '',
    remaining_refundable: Math.max(0, remaining),
    actions: {
      start: order.status === 'reserved' && canOperate,
      complete: order.status === 'charging' && canOperate,
      cancel: order.status === 'reserved' && canOperate,
      refund: order.status === 'completed' && remaining > 0 && canOperate,
    },
  };
}
function ticketVerification(ticket) {
  const pile = state.piles[ticket.pile_id] || {};
  const lastSeen = parseDt(pile.last_seen);
  const heartbeatFresh = Boolean(lastSeen && (Date.now() - lastSeen.getTime()) / 60000 <= HEARTBEAT_FRESH_MINUTES);
  const createdAt = parseDt(ticket.created_at);
  const testOrders = Object.values(state.orders).filter((order) => {
    if (order.ticket_id !== ticket.id || !order.is_test || order.status !== 'completed') return false;
    const completedAt = parseDt(order.completed_at);
    return Boolean(completedAt && (!createdAt || completedAt >= createdAt));
  });
  testOrders.sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  const testOrder = testOrders[0] || null;
  const reasons = [];
  if (ticket.status !== 'pending_acceptance') reasons.push('工单尚未进入待验收状态');
  if (!ticket.resolution) reasons.push('缺少维修回填说明');
  if (!heartbeatFresh) reasons.push(`设备心跳超过 ${HEARTBEAT_FRESH_MINUTES} 分钟未更新`);
  if (!testOrder) reasons.push('缺少完整的测试订单');
  return {
    heartbeat_fresh: heartbeatFresh,
    heartbeat_at: lastSeen ? iso(lastSeen) : null,
    heartbeat_age_minutes: lastSeen ? round(minutesSince(lastSeen) || 0, 1) : null,
    test_order_id: testOrder ? testOrder.id : null,
    test_order_completed_at: testOrder ? testOrder.completed_at : null,
    can_close: reasons.length === 0,
    reasons,
    policy: { heartbeat_fresh_minutes: HEARTBEAT_FRESH_MINUTES, requires_test_order: true, requires_resolution: true },
  };
}
function ticketPublic(ticket) {
  const pile = state.piles[ticket.pile_id] || {};
  const community = state.communities[ticket.community_id] || {};
  const assignee = state.users[ticket.assignee_id || ''] || null;
  const due = parseDt(ticket.due_at);
  return {
    ...ticket,
    pile_code: pile.code || '',
    community_name: community.name || '',
    assignee_name: assignee ? assignee.display_name : null,
    overdue: Boolean(due && due < new Date() && ticket.status !== 'closed'),
    age_minutes: round(minutesSince(ticket.created_at) || 0, 1),
    verification: ticketVerification(ticket),
  };
}
function approvalPublic(approval) {
  const requester = state.users[approval.requester_id || ''] || {};
  return {
    ...approval,
    requester_name: requester.display_name || approval.requester_name || '',
    requester_role: requester.role || '',
  };
}

// -------------------------------------------------------------------- audit
function appendAudit({ action, actor, actorId, actorName, actorRole, targetType = '', targetId = '', detail = '', ip = '', tenantId }) {
  if (actor) {
    actorId = actor.id;
    actorName = actor.display_name;
    actorRole = actor.role;
    tenantId = tenantId || actor.tenant_id;
  }
  const text = detail && typeof detail === 'object' ? JSON.stringify(detail) : String(detail ?? '');
  const entry = {
    id: `AU${String(state.audit.length + 1).padStart(5, '0')}`,
    tenant_id: tenantId || '',
    trace_id: traceId(),
    actor_id: actorId || 'system',
    actor_name: actorName || '系统',
    actor_role: actorRole || 'system',
    action,
    target_type: targetType,
    target_id: targetId,
    detail: sanitizeText(text).slice(0, 2000),
    ip: String(ip || '').slice(0, 64),
    at: iso(),
  };
  state.audit.push(entry);
  if (state.audit.length > 1200) state.audit.splice(0, state.audit.length - 1200);
  return entry;
}

// -------------------------------------------------------------- reservations
function hasActiveReservation(pileId, start, end, ignore = '') {
  for (const order of Object.values(state.orders)) {
    if (order.id === ignore || order.pile_id !== pileId || !ORDER_ACTIVE.has(order.status)) continue;
    if (overlaps(start, end, order.reserved_start, order.reserved_end)) return order;
  }
  return null;
}
function expireStaleReservations() {
  const stale = Object.values(state.orders).some((order) => order.status === 'reserved' && (parseDt(order.reserved_end) || new Date()) < new Date());
  if (!stale) return;
  for (const order of Object.values(state.orders)) {
    if (order.status !== 'reserved') continue;
    if ((parseDt(order.reserved_end) || new Date()) >= new Date()) continue;
    order.status = 'cancelled';
    order.cancelled_at = iso();
    order.cancel_reason = '预约超时未开始，系统自动释放';
    const pile = state.piles[order.pile_id];
    if (pile && pile.status === 'reserved') pile.status = 'available';
    appendAudit({ action: 'reservation_expired', actorId: 'system', actorName: '预约引擎', actorRole: 'system', targetType: 'order', targetId: order.id, detail: '预约结束时间已过，自动释放充电桩', tenantId: order.tenant_id });
  }
}
function createReservation(user, body, idem, ip) {
  const start = parseDt(body.starts_at);
  const end = parseDt(body.ends_at);
  need(start, 'starts_at', '开始时间格式不正确');
  need(end, 'ends_at', '结束时间格式不正确');
  const current = new Date();
  if (end <= start) throw badRequest('结束时间必须晚于开始时间');
  if (start < new Date(current.getTime() - 5 * 60000)) throw badRequest('不能预约已经过去的时间段');
  if (start > new Date(current.getTime() + 7 * 86400000)) throw badRequest('最多支持提前 7 天预约');
  const duration = end - start;
  if (duration < 30 * 60000) throw badRequest('预约时长不能少于 30 分钟');
  if (duration > MAX_RESERVATION_HOURS * 3600000) throw badRequest(`单次预约不能超过 ${MAX_RESERVATION_HOURS} 小时`);
  needText(body.pile_id, 'pile_id', { min: 1, max: 36 });
  const note = sanitizeText(String(body.note || '')).slice(0, 200);

  if (idem) {
    const existing = Object.values(state.orders).find((order) => order.tenant_id === user.tenant_id && order.idempotency_key === idem);
    if (existing) return orderPublic(existing, user);
  }
  expireStaleReservations();
  const pile = getPile(body.pile_id);
  ensurePileScope(user, pile);
  if (PILE_BLOCKED.has(pile.status)) throw conflict('该充电桩当前不可用，请选择其他设备', 'PILE_UNAVAILABLE');
  if (pile.status === 'charging') throw conflict('该充电桩正在充电，请选择其他设备', 'PILE_CHARGING');
  if (pile.status === 'reserved') {
    const existing = hasActiveReservation(pile.id, start, end);
    if (existing) throw conflict('该时段已被预约，请选择其他时间', 'RESERVATION_CONFLICT', { conflicting_order: existing.id });
    pile.status = 'available';
  }
  let targetUserId = user.id;
  if (body.user_id && isStaff(user)) {
    const target = getUser(body.user_id);
    ensureTenantRecord(user, target, '用户');
    if (target.role !== 'user') throw badRequest('只能为居民用户创建预约');
    if (!(target.community_ids || []).includes(pile.community_id)) throw badRequest('目标用户不属于该社区');
    targetUserId = target.id;
  } else if (body.user_id && body.user_id !== user.id) {
    throw forbidden('居民用户只能为本人预约');
  }
  if (user.role === 'user' && !(user.community_ids || []).includes(pile.community_id)) {
    throw forbidden('只能预约本人所在社区的充电桩');
  }
  const conflicting = hasActiveReservation(pile.id, start, end);
  if (conflicting) {
    state.meta.reservation_conflicts = Number(state.meta.reservation_conflicts || 0) + 1;
    throw conflict('该时段已被预约，请选择其他时间', 'RESERVATION_CONFLICT', { conflicting_order: conflicting.id });
  }
  const orderId = nextId('orders', 'O', 4);
  const order = {
    id: orderId, tenant_id: user.tenant_id, user_id: targetUserId,
    pile_id: pile.id, community_id: pile.community_id, status: 'reserved',
    amount: 0, kwh: 0, price: pile.price, created_at: iso(),
    reserved_start: iso(start), reserved_end: iso(end),
    started_at: null, completed_at: null, idempotency_key: idem, is_test: false,
    ticket_id: null, refund_amount: 0, refunded_at: null, cancelled_at: null,
    cancel_reason: null, trace_id: null, note,
  };
  state.orders[orderId] = order;
  pile.status = 'reserved';
  state.meta.reservation_attempts = Number(state.meta.reservation_attempts || 0) + 1;
  state.meta.reservation_success = Number(state.meta.reservation_success || 0) + 1;
  appendAudit({ action: 'create_reservation', actor: user, targetType: 'order', targetId: orderId, detail: `${pile.code} 预约 ${iso(start)} 至 ${iso(end)}`, ip });
  return orderPublic(order, user);
}
function listReservations(user) {
  expireStaleReservations();
  const items = sortDesc(ordersFor(user).filter((order) => order.status === 'reserved').map((order) => orderPublic(order, user)), 'reserved_start');
  return { items, total: items.length };
}
function cancelReservation(user, orderId, reason = '用户取消', ip = '') {
  const order = getOrder(orderId);
  ensureOrderScope(user, order);
  if (order.status !== 'reserved') throw conflict('只有已预约且未开始的订单可以取消', 'ORDER_STATE_INVALID');
  order.status = 'cancelled';
  order.cancelled_at = iso();
  order.cancel_reason = sanitizeText(reason || '用户取消');
  const pile = state.piles[order.pile_id];
  if (pile && pile.status === 'reserved') pile.status = 'available';
  appendAudit({ action: 'cancel_reservation', actor: user, targetType: 'order', targetId: orderId, detail: order.cancel_reason, ip });
  return orderPublic(order, user);
}

// -------------------------------------------------------------------- orders
function listOrders(user, { status, communityId, search, page, pageSize }) {
  expireStaleReservations();
  let items = [];
  for (const order of ordersFor(user)) {
    if (status && order.status !== status) continue;
    if (communityId && order.community_id !== communityId) continue;
    if (search) {
      const pile = state.piles[order.pile_id] || {};
      const owner = state.users[order.user_id] || {};
      const haystack = `${order.id} ${pile.code || ''} ${owner.display_name || ''}`.toLowerCase();
      if (!haystack.includes(String(search).toLowerCase())) continue;
    }
    items.push(orderPublic(order, user));
  }
  items = sortDesc(items, 'created_at');
  const total = items.length;
  const start = Math.max(0, (page - 1) * pageSize);
  return { items: items.slice(start, start + pageSize), total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
function getOrderDetail(user, orderId) {
  const order = getOrder(orderId);
  ensureOrderScope(user, order);
  return orderPublic(order, user);
}
function startOrder(user, orderId, ip = '') {
  const order = getOrder(orderId);
  ensureOrderScope(user, order);
  if (order.status !== 'reserved') throw conflict('订单当前状态不能开始充电', 'ORDER_STATE_INVALID');
  const start = parseDt(order.reserved_start);
  const end = parseDt(order.reserved_end);
  const current = new Date();
  if (start && current < new Date(start.getTime() - 15 * 60000)) throw conflict('还未到预约开始时间，请稍后再试', 'TOO_EARLY');
  if (end && current > new Date(end.getTime() + 10 * 60000)) throw conflict('预约已过期，请重新预约', 'RESERVATION_EXPIRED');
  const pile = getPile(order.pile_id);
  if (PILE_BLOCKED.has(pile.status)) throw conflict('充电桩故障或离线，无法开始充电', 'PILE_UNAVAILABLE');
  if (pile.status === 'charging') throw conflict('充电桩已被其他会话占用', 'PILE_BUSY');
  order.status = 'charging';
  order.started_at = iso();
  pile.status = 'charging';
  pile.last_seen = iso();
  appendAudit({ action: 'start_charging', actor: user, targetType: 'order', targetId: orderId, detail: `${pile.code} 开始充电`, ip });
  return orderPublic(order, user);
}
function completeOrder(user, orderId, body, ip = '') {
  const order = getOrder(orderId);
  ensureOrderScope(user, order);
  if (order.status !== 'charging') throw conflict('只有充电中的订单可以完成', 'ORDER_STATE_INVALID');
  const kwh = round(asNumber(body.kwh, 'kwh'), 2);
  if (kwh <= 0 || kwh > 300) throw fieldError('kwh', '充电量需在 0 至 300 度之间');
  const pile = getPile(order.pile_id);
  const amount = round(kwh * Number(order.price || pile.price || 0), 2);
  order.status = 'completed';
  order.kwh = kwh;
  order.amount = amount;
  order.completed_at = iso();
  order.note = sanitizeText(body.note || order.note || '');
  pile.status = 'available';
  pile.last_seen = iso();
  pile.today_kwh = round(Number(pile.today_kwh || 0) + kwh, 2);
  pile.total_kwh = round(Number(pile.total_kwh || 0) + kwh, 2);
  appendAudit({ action: 'complete_charging', actor: user, targetType: 'order', targetId: orderId, detail: `${pile.code} 充电 ${kwh} 度，结算 ¥${fmt2(amount)}`, ip });
  return orderPublic(order, user);
}
function cancelOrder(user, orderId, body, ip = '') {
  return cancelReservation(user, orderId, body.reason || '用户取消', ip);
}
function requestRefund(user, body, ip = '') {
  const order = getOrder(body.order_id);
  ensureOrderScope(user, order);
  if (!['completed', 'refunded'].includes(order.status)) throw conflict('只有已完成的订单可以申请退款', 'ORDER_STATE_INVALID');
  const remaining = money(Number(order.amount || 0) - Number(order.refund_amount || 0));
  const amount = money(asNumber(body.amount, 'amount'));
  if (amount <= 0) throw fieldError('amount', '退款金额必须大于 0');
  if (amount > remaining + 0.001) throw badRequest(`退款金额不能超过可退金额 ¥${fmt2(remaining)}`, 'REFUND_EXCEEDS_REMAINING');
  if (order.refund_pending_approval) throw conflict('该订单已有待处理的退款申请', 'REFUND_PENDING');
  needText(body.reason, 'reason', { min: 4, max: 500 });
  const approval = createApprovalRecord(user, {
    type: 'refund', reason: body.reason, payload: { order_id: order.id, amount },
    amount, impact: `订单 ${order.id} · ${state.communities[order.community_id]?.name || ''} · 退款 ¥${fmt2(amount)}`,
    title: '订单退款审批', idempotencyKey: null,
  });
  order.refund_pending_approval = approval.id;
  appendAudit({ action: 'refund_requested', actor: user, targetType: 'approval', targetId: approval.id, detail: `订单 ${order.id} 申请退款 ¥${fmt2(amount)}`, ip });
  return approvalPublic(approval);
}

// -------------------------------------------------------------- device events
function ingestDeviceEvent(actor, body, ip = '') {
  needText(body.event_id, 'event_id', { min: 4, max: 80 });
  needText(body.pile_id, 'pile_id', { min: 1, max: 36 });
  const eventTypes = ['heartbeat', 'power', 'current', 'temperature', 'offline', 'fault', 'charge_interrupted', 'restored'];
  need(eventTypes.includes(body.event_type), 'event_type', '事件类型不合法');
  const eventId = body.event_id;
  if (state.events[eventId]) {
    const existing = state.events[eventId];
    return { accepted: true, duplicate: true, event_id: eventId, pile_id: existing.pile_id, ticket_id: existing.ticket_id ?? null, trace_id: existing.trace_id ?? null };
  }
  const pile = getPile(body.pile_id);
  ensureTenantRecord(actor, pile, '充电桩');
  if (!scopedCommunities(actor).includes(pile.community_id)) throw forbidden('该设备不在你的数据授权范围内');
  const occurred = body.occurred_at ? parseDt(body.occurred_at) : new Date();
  if (!occurred) throw fieldError('occurred_at', '事件时间格式不正确');
  const payload = { ...(body.payload || {}) };
  for (const key of ['password', 'token', 'secret']) delete payload[key];
  const event = {
    id: eventId, tenant_id: pile.tenant_id, pile_id: pile.id, event_type: body.event_type,
    payload, occurred_at: iso(occurred), processed_at: iso(), trace_id: traceId(), ticket_id: null,
  };
  state.events[eventId] = event;
  pile.last_seen = iso(occurred);
  let ticketId = null;
  const castNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  if (['heartbeat', 'restored'].includes(body.event_type)) {
    if (body.event_type === 'restored' && ['fault', 'offline'].includes(pile.status)) {
      pile.status = 'available';
      pile.faults = Math.max(0, Number(pile.faults || 0) - 1);
    }
    const temperature = castNumber(payload.temperature);
    if (temperature !== null) pile.temperature = round(temperature, 1);
  } else if (['power', 'current'].includes(body.event_type)) {
    const temperature = castNumber(payload.temperature);
    if (temperature !== null) pile.temperature = round(temperature, 1);
    const power = castNumber(payload.power);
    if (power !== null) pile.last_power = round(Math.max(0, power), 2);
  } else if (body.event_type === 'temperature') {
    const temperature = castNumber(payload.temperature) ?? 0;
    pile.temperature = round(temperature, 1);
    if (temperature >= 65 && !['fault', 'offline'].includes(pile.status)) {
      pile.status = 'fault';
      pile.faults = Number(pile.faults || 0) + 1;
      ticketId = openOrEscalateTicket(pile, 'P1', `${pile.code} 温度过高（${temperature.toFixed(1)}°C）`, `温度传感器上报 ${temperature.toFixed(1)}°C，超过 65°C 阈值，已自动停机并创建 P1 工单。`, body.event_type, actor);
    }
  } else if (['offline', 'fault', 'charge_interrupted'].includes(body.event_type)) {
    pile.status = body.event_type === 'offline' ? 'offline' : 'fault';
    pile.faults = Number(pile.faults || 0) + 1;
    const level = ['offline', 'fault'].includes(body.event_type) || Number(pile.faults) >= 3 ? 'P1' : 'P2';
    const label = { offline: '设备离线', fault: '设备故障', charge_interrupted: '充电中断' }[body.event_type];
    const detail = payload.code || payload.reason || '设备上报异常事件';
    ticketId = openOrEscalateTicket(pile, level, `${pile.code} ${label}`, `${label}：${detail}。事件编号 ${eventId}，设备累计故障 ${pile.faults} 次。`, body.event_type, actor);
  }
  event.ticket_id = ticketId;
  event.trace_id = traceId();
  appendAudit({
    action: 'device_event',
    actorId: actor.id, actorName: actor.display_name || '设备网关', actorRole: actor.role || 'system', tenantId: actor.tenant_id,
    targetType: 'pile', targetId: pile.id, detail: `接收 ${body.event_type} 事件 ${eventId}`, ip,
  });
  return { accepted: true, duplicate: false, event_id: eventId, pile_id: pile.id, pile_status: pile.status, ticket_id: ticketId };
}
function openOrEscalateTicket(pile, level, title, description, eventType, actor) {
  const existing = Object.values(state.tickets).find((ticket) => ticket.pile_id === pile.id && TICKET_OPEN.has(ticket.status));
  if (existing) {
    const ranks = { P3: 1, P2: 2, P1: 3 };
    if ((ranks[level] || 0) > (ranks[existing.level] || 0)) existing.level = level;
    existing.updated_at = iso();
    existing.history.push({ at: iso(), action: 'escalated', actor_id: 'system', actor_name: '设备规则引擎', note: `重复异常事件：${description}` });
    return existing.id;
  }
  const ticketId = nextId('tickets', 'T', 4);
  const created = new Date();
  state.tickets[ticketId] = {
    id: ticketId, tenant_id: pile.tenant_id, pile_id: pile.id, community_id: pile.community_id,
    level, title, description, status: 'open', assignee_id: null,
    created_at: iso(created), updated_at: iso(created),
    due_at: iso(new Date(created.getTime() + (LEVEL_HOURS[level] || 24) * 3600000)),
    closed_at: null, resolution: null,
    verification: { heartbeat_at: null, test_order_id: null, verified_at: null },
    history: [{ at: iso(created), action: 'created', actor_id: 'system', actor_name: '设备规则引擎', note: `${eventType} 事件自动生成 ${level} 工单` }],
    source: 'device_rule', reporter_id: null,
  };
  return ticketId;
}
function listEvents(user, limit) {
  const communities = new Set(scopedCommunities(user));
  const items = sortDesc(Object.values(state.events).filter((event) => event.tenant_id === user.tenant_id && communities.has(state.piles[event.pile_id]?.community_id)), 'occurred_at').slice(0, limit);
  return { items, total: items.length };
}

// ------------------------------------------------------------------- tickets
function listTickets(user, { status, level, communityId }) {
  let items = [];
  for (const ticket of ticketsFor(user)) {
    if (status && ticket.status !== status) continue;
    if (level && ticket.level !== level) continue;
    if (communityId && ticket.community_id !== communityId) continue;
    items.push(ticketPublic(ticket));
  }
  items = sortDesc(items, 'created_at');
  return { items, total: items.length };
}
function getTicketDetail(user, ticketId) {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  return ticketPublic(ticket);
}
function createTicket(user, body, ip = '') {
  const pile = getPile(body.pile_id);
  ensurePileScope(user, pile);
  if (user.role === 'user' && !(user.community_ids || []).includes(pile.community_id)) throw forbidden('只能为本人所在社区提交报修');
  const title = needText(body.title, 'title', { min: 3, max: 120 });
  const description = sanitizeText(String(body.description || '')).slice(0, 1000);
  const level = isStaff(user) && ['P1', 'P2', 'P3'].includes(body.level) ? body.level : 'P3';
  const ticketId = nextId('tickets', 'T', 4);
  const created = new Date();
  state.tickets[ticketId] = {
    id: ticketId, tenant_id: pile.tenant_id, pile_id: pile.id, community_id: pile.community_id,
    level, title, description, status: 'open', assignee_id: null,
    created_at: iso(created), updated_at: iso(created), due_at: iso(new Date(created.getTime() + LEVEL_HOURS[level] * 3600000)),
    closed_at: null, resolution: null,
    verification: { heartbeat_at: null, test_order_id: null, verified_at: null },
    history: [{ at: iso(created), action: 'created', actor_id: user.id, actor_name: user.display_name, note: '手动创建工单' }],
    source: user.role === 'user' ? 'user_report' : 'manual', reporter_id: user.id,
  };
  appendAudit({ action: 'create_ticket', actor: user, targetType: 'ticket', targetId: ticketId, detail: `${pile.code} ${title}`, ip });
  return ticketPublic(state.tickets[ticketId]);
}
function assignTicket(user, ticketId, body, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  if (!(canManage(user) || isAdmin(user))) throw forbidden('只有运营人员可以分派工单');
  const assignee = getUser(body.assignee_id);
  ensureTenantRecord(user, assignee, '维修人员');
  if (assignee.role !== 'repairer') throw badRequest('只能分派给维修人员');
  if (!(assignee.community_ids || []).includes(ticket.community_id)) throw badRequest('该维修人员未获得此社区授权');
  if (ticket.status === 'closed') throw conflict('已关闭的工单不能再分派', 'TICKET_CLOSED');
  if (ticket.status === 'pending_acceptance') throw conflict('待验收工单不能再分派，请先完成验收', 'TICKET_STATE_INVALID');
  ticket.assignee_id = assignee.id;
  ticket.status = 'assigned';
  ticket.updated_at = iso();
  ticket.history.push({ at: iso(), action: 'assigned', actor_id: user.id, actor_name: user.display_name, note: `分派给 ${assignee.display_name}` });
  appendAudit({ action: 'assign_ticket', actor: user, targetType: 'ticket', targetId: ticketId, detail: `分派给 ${assignee.display_name}`, ip });
  return ticketPublic(ticket);
}
function acceptTicket(user, ticketId, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  if (ticket.status !== 'assigned') throw conflict('只有已分派的工单可以接单', 'TICKET_STATE_INVALID');
  if (user.role !== 'admin' && ticket.assignee_id !== user.id) throw forbidden('只能接本人工单');
  ticket.status = 'processing';
  ticket.updated_at = iso();
  ticket.history.push({ at: iso(), action: 'accepted', actor_id: user.id, actor_name: user.display_name, note: '维修人员已接单' });
  appendAudit({ action: 'accept_ticket', actor: user, targetType: 'ticket', targetId: ticketId, detail: '接单', ip });
  return ticketPublic(ticket);
}
function resolveTicket(user, ticketId, body, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  if (!['assigned', 'processing'].includes(ticket.status)) throw conflict('当前工单状态不能回填维修结果', 'TICKET_STATE_INVALID');
  if (user.role === 'repairer' && ticket.assignee_id !== user.id) throw forbidden('只能处理分配给本人的工单');
  ticket.status = 'pending_acceptance';
  ticket.resolution = sanitizeText(needText(body.resolution, 'resolution', { min: 5, max: 1000 }));
  ticket.updated_at = iso();
  ticket.history.push({ at: iso(), action: 'resolved', actor_id: user.id, actor_name: user.display_name, note: ticket.resolution });
  appendAudit({ action: 'resolve_ticket', actor: user, targetType: 'ticket', targetId: ticketId, detail: ticket.resolution, ip });
  return ticketPublic(ticket);
}
function createTestOrder(user, ticketId, body, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  if (ticket.status !== 'pending_acceptance') throw conflict('只有待验收工单可以创建测试订单', 'TICKET_STATE_INVALID');
  const pile = getPile(ticket.pile_id);
  if (['offline', 'maintenance', 'fault'].includes(pile.status)) throw conflict('设备仍处于故障/离线/维护状态，无法完成测试订单', 'PILE_UNAVAILABLE');
  const kwh = round(asNumber(body.kwh ?? 0.4, 'kwh'), 2);
  if (kwh <= 0 || kwh > 5) throw fieldError('kwh', '测试充电量需在 0 至 5 度之间');
  const orderId = nextId('orders', 'O', 4);
  const current = new Date();
  const order = {
    id: orderId, tenant_id: ticket.tenant_id, user_id: user.id, pile_id: pile.id, community_id: ticket.community_id,
    status: 'completed', amount: 0, kwh, price: 0, created_at: iso(current),
    reserved_start: iso(new Date(current.getTime() - 2 * 60000)),
    reserved_end: iso(new Date(current.getTime() + 18 * 60000)),
    started_at: iso(new Date(current.getTime() - 2 * 60000)), completed_at: iso(current),
    idempotency_key: null, is_test: true, ticket_id: ticket.id,
    refund_amount: 0, refunded_at: null, cancelled_at: null, cancel_reason: null, trace_id: null, note: '工单验收测试订单',
  };
  state.orders[orderId] = order;
  ticket.verification.test_order_id = orderId;
  ticket.updated_at = iso();
  ticket.history.push({ at: iso(), action: 'test_order', actor_id: user.id, actor_name: user.display_name, note: `创建测试订单 ${orderId}` });
  appendAudit({ action: 'create_test_order', actor: user, targetType: 'ticket', targetId: ticketId, detail: `测试订单 ${orderId}`, ip });
  return { ticket: ticketPublic(ticket), order: orderPublic(order, user) };
}
function simulateHeartbeat(user, ticketId, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  const pile = getPile(ticket.pile_id);
  pile.last_seen = iso();
  pile.temperature = round(Math.min(Number(pile.temperature || 35), 42), 1);
  const eventId = `HB-${ticketId}-${Math.floor(Date.now() / 1000)}`;
  state.events[eventId] = {
    id: eventId, tenant_id: ticket.tenant_id, pile_id: pile.id, event_type: 'heartbeat',
    payload: { source: 'verification', temperature: pile.temperature },
    occurred_at: iso(), processed_at: iso(), trace_id: '', ticket_id: ticketId,
  };
  appendAudit({ action: 'heartbeat_check', actor: user, targetType: 'ticket', targetId: ticketId, detail: '验收心跳检查', ip });
  return { ticket: ticketPublic(ticket), heartbeat_at: pile.last_seen };
}
function closeTicket(user, ticketId, ip = '') {
  const ticket = getTicket(ticketId);
  ensureTicketScope(user, ticket);
  if (ticket.status === 'closed') throw conflict('工单已关闭，不能重复关闭', 'TICKET_CLOSED');
  const check = ticketVerification(ticket);
  if (!check.can_close) throw conflict('工单验收未通过：' + check.reasons.join('；'), 'TICKET_VERIFICATION_FAILED', { checks: check });
  const pile = getPile(ticket.pile_id);
  ticket.status = 'closed';
  ticket.closed_at = iso();
  ticket.updated_at = iso();
  ticket.verification.heartbeat_at = check.heartbeat_at;
  ticket.verification.verified_at = iso();
  ticket.history.push({ at: iso(), action: 'closed', actor_id: user.id, actor_name: user.display_name, note: '验收通过并关闭工单' });
  pile.status = 'available';
  pile.last_seen = iso();
  appendAudit({ action: 'close_ticket', actor: user, targetType: 'ticket', targetId: ticketId, detail: '心跳 + 测试订单验收通过', ip });
  return ticketPublic(ticket);
}

// ----------------------------------------------------------------- approvals
function createApprovalRecord(user, { type, reason, payload, amount, impact, title, idempotencyKey }) {
  if (idempotencyKey) {
    const existing = Object.values(state.approvals).find((approval) => approval.tenant_id === user.tenant_id && approval.idempotency_key === idempotencyKey);
    if (existing) return existing;
  }
  const approvalId = nextId('approvals', 'AP', 4);
  const riskFactors = ['涉及资金或设备状态变更', '执行前必须人工复核'];
  if (type === 'refund') riskFactors.push('将改变订单结算状态');
  if (type === 'price_change') riskFactors.push('影响居民账单');
  if (type === 'stop_pile') riskFactors.push('设备将停止服务');
  if (type === 'batch_reassign') riskFactors.push('批量修改工单责任人');
  const approval = {
    id: approvalId, tenant_id: user.tenant_id, type, title, reason: sanitizeText(reason),
    payload, impact, amount: money(amount), risk: 'high', risk_factors: riskFactors,
    status: 'pending', requester_id: user.id, requester_name: user.display_name,
    created_at: iso(), decided_by: null, decided_at: null, decision_comment: null,
    executed_at: null, execution_result: null, trace_id: '', idempotency_key: idempotencyKey,
  };
  state.approvals[approvalId] = approval;
  return approval;
}
function createApproval(user, body, idem, ip = '') {
  const type = body.type;
  need(['refund', 'stop_pile', 'price_change', 'batch_reassign'].includes(type), 'type', '审批类型不合法');
  needText(body.reason, 'reason', { min: 4, max: 500 });
  let payload = { ...(body.payload || {}) };
  let amount = money(body.amount || 0);
  const title = { refund: '订单退款审批', stop_pile: '停机检修审批', price_change: '电价调整审批', batch_reassign: '批量改派审批' }[type];
  let impact = '';
  if (type === 'refund') {
    const order = getOrder(String(payload.order_id || ''));
    ensureOrderScope(user, order);
    if (!['completed', 'refunded'].includes(order.status)) throw conflict('订单当前状态不可退款', 'ORDER_STATE_INVALID');
    if (order.refund_pending_approval) throw conflict('该订单已有待处理的退款申请', 'REFUND_PENDING');
    const remaining = money(Number(order.amount || 0) - Number(order.refund_amount || 0));
    amount = amount || remaining;
    if (amount <= 0 || amount > remaining + 0.001) throw badRequest(`退款金额需大于 0 且不超过可退金额 ¥${fmt2(remaining)}`, 'REFUND_EXCEEDS_REMAINING');
    payload = { order_id: order.id, amount };
    impact = `订单 ${order.id} · ${state.communities[order.community_id]?.name || ''} · 退款 ¥${fmt2(amount)}`;
  } else if (type === 'stop_pile') {
    const pile = getPile(String(payload.pile_id || ''));
    ensurePileScope(user, pile);
    if (!canManage(user)) throw forbidden('只有运营人员可以申请停机');
    payload = { pile_id: pile.id, duration_hours: Number.parseInt(payload.duration_hours ?? 8, 10) || 8 };
    impact = `${state.communities[pile.community_id]?.name || ''} · ${pile.code} · 停机 ${payload.duration_hours} 小时`;
  } else if (type === 'price_change') {
    const communityId = String(payload.community_id || '');
    ensureCommunity(user, communityId);
    if (!canManage(user)) throw forbidden('只有运营人员可以申请调价');
    const newPrice = Number(payload.new_price);
    if (!Number.isFinite(newPrice)) throw unprocessable('新的电价必须是数字');
    if (newPrice < 0.2 || newPrice > 5.0) throw unprocessable('电价需在 0.20 至 5.00 元/度之间');
    const pileIds = asList(payload.pile_ids).length
      ? asList(payload.pile_ids)
      : Object.values(state.piles).filter((pile) => pile.community_id === communityId && pile.tenant_id === user.tenant_id).map((pile) => pile.id);
    const oldPrices = [...new Set(pileIds.map((id) => state.piles[id]).filter(Boolean).map((pile) => Number(pile.price)))].sort((a, b) => a - b);
    const oldPrice = oldPrices.length ? oldPrices[0] : 0;
    payload = { community_id: communityId, pile_ids: pileIds, old_price: oldPrice, new_price: round(newPrice, 2) };
    const change = oldPrice ? (round(newPrice, 2) - oldPrice) / oldPrice * 100 : 0;
    impact = `${state.communities[communityId]?.name || ''} · ${pileIds.length} 台设备 · 电价 ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  } else {
    if (!canManage(user)) throw forbidden('只有运营人员可以批量改派');
    const ticketIds = asList(payload.ticket_ids);
    const assignee = getUser(String(payload.assignee_id || ''));
    if (assignee.role !== 'repairer') throw badRequest('只能改派给维修人员');
    const tickets = [];
    for (const ticketId of ticketIds) {
      const ticket = getTicket(String(ticketId));
      ensureTicketScope(user, ticket);
      tickets.push(ticket.id);
    }
    if (!tickets.length) throw badRequest('至少选择一张工单');
    payload = { ticket_ids: tickets, assignee_id: assignee.id };
    impact = `批量改派 ${tickets.length} 张工单给 ${assignee.display_name}`;
  }
  const approval = createApprovalRecord(user, { type, reason: body.reason, payload, amount, impact, title, idempotencyKey: idem });
  if (type === 'refund' && state.orders[payload.order_id]) state.orders[payload.order_id].refund_pending_approval = approval.id;
  appendAudit({ action: 'approval_created', actor: user, targetType: 'approval', targetId: approval.id, detail: `${title}：${impact}`, ip });
  return approvalPublic(approval);
}
function listApprovals(user, { status, type }) {
  let items = [];
  for (const approval of approvalsFor(user)) {
    if (status && approval.status !== status) continue;
    if (type && approval.type !== type) continue;
    items.push(approvalPublic(approval));
  }
  items = sortDesc(items, 'created_at');
  return { items, total: items.length };
}
function getApprovalDetail(user, approvalId) {
  const approval = state.approvals[approvalId];
  if (!approval) throw notFound('审批不存在');
  ensureApprovalScope(user, approval);
  return approvalPublic(approval);
}
function decideApproval(user, approvalId, body, ip = '') {
  const approval = state.approvals[approvalId];
  if (!approval) throw notFound('审批不存在');
  ensureTenantRecord(user, approval, '审批');
  if (!canApprove(user)) throw forbidden('只有管理员或财务审批人可以处理审批');
  if (approval.status !== 'pending') throw conflict('该审批已处理，不能重复审批', 'APPROVAL_ALREADY_DECIDED');
  if (approval.requester_id === user.id) throw forbidden('申请人与审批人不能为同一人');
  const approved = Boolean(body.approved);
  const comment = String(body.comment || '');
  if (!approved && comment.trim().length < 2) throw badRequest('驳回时必须填写审批意见');
  approval.decided_by = user.id;
  approval.decided_at = iso();
  approval.decision_comment = sanitizeText(comment);
  if (!approved) {
    approval.status = 'rejected';
    if (approval.type === 'refund') {
      const order = state.orders[String(approval.payload?.order_id || '')];
      if (order && order.refund_pending_approval === approvalId) delete order.refund_pending_approval;
    }
    appendAudit({ action: 'approval_rejected', actor: user, targetType: 'approval', targetId: approvalId, detail: comment, ip });
    return approvalPublic(approval);
  }
  try {
    const result = executeApproval(approval, user);
    approval.status = 'executed';
    approval.executed_at = iso();
    approval.execution_result = result;
    appendAudit({ action: 'approval_executed', actor: user, targetType: 'approval', targetId: approvalId, detail: result, ip });
  } catch (error) {
    approval.status = 'failed';
    approval.executed_at = iso();
    approval.execution_result = `执行失败：${error.message || error}`;
    if (approval.type === 'refund') {
      const order = state.orders[String(approval.payload?.order_id || '')];
      if (order && order.refund_pending_approval === approvalId) delete order.refund_pending_approval;
    }
    appendAudit({ action: 'approval_failed', actor: user, targetType: 'approval', targetId: approvalId, detail: approval.execution_result, ip });
  }
  return approvalPublic(approval);
}
function executeApproval(approval, user) {
  const payload = approval.payload || {};
  if (approval.type === 'refund') {
    const order = getOrder(String(payload.order_id || ''));
    if (order.status === 'refunded' && Number(order.refund_amount || 0) >= approval.amount) throw conflict('订单已退款，不能重复执行', 'REFUND_ALREADY_EXECUTED');
    const remaining = money(Number(order.amount || 0) - Number(order.refund_amount || 0));
    const amount = Math.min(money(approval.amount), remaining);
    if (amount <= 0) throw conflict('订单没有可退金额', 'REFUND_EXCEEDS_REMAINING');
    order.refund_amount = money(Number(order.refund_amount || 0) + amount);
    order.refunded_at = iso();
    order.status = 'refunded';
    delete order.refund_pending_approval;
    return `订单 ${order.id} 已退款 ¥${fmt2(amount)}`;
  }
  if (approval.type === 'stop_pile') {
    const pile = getPile(String(payload.pile_id || ''));
    pile.status = 'offline';
    pile.last_seen = iso();
    const ticketId = openOrEscalateTicket(pile, 'P1', `${pile.code} 停机检修`, `按审批 ${approval.id} 执行停机检修，预计 ${payload.duration_hours || 8} 小时。`, 'stop_pile', user);
    return `${pile.code} 已停机，工单 ${ticketId}`;
  }
  if (approval.type === 'price_change') {
    const pileIds = asList(payload.pile_ids);
    const newPrice = Number(payload.new_price || 0);
    for (const pileId of pileIds) {
      const pile = state.piles[pileId];
      if (pile) pile.price = newPrice;
    }
    return `${pileIds.length} 台设备电价已调整为 ¥${fmt2(newPrice)}/度`;
  }
  if (approval.type === 'batch_reassign') {
    const assignee = getUser(String(payload.assignee_id || ''));
    let changed = 0;
    for (const ticketId of asList(payload.ticket_ids)) {
      const ticket = state.tickets[ticketId];
      if (ticket && ticket.status !== 'closed') {
        ticket.assignee_id = assignee.id;
        ticket.status = 'assigned';
        ticket.updated_at = iso();
        ticket.history.push({ at: iso(), action: 'reassigned', actor_id: user.id, actor_name: user.display_name, note: `审批 ${approval.id} 批量改派给 ${assignee.display_name}` });
        changed += 1;
      }
    }
    return `${changed} 张工单已改派给 ${assignee.display_name}`;
  }
  throw badRequest('未知的审批类型');
}

// --------------------------------------------------------------------- users
function listUsers(user, { role, search }) {
  if (!isAdmin(user)) throw forbidden('只有系统管理员可以查看用户列表');
  const items = Object.values(state.users)
    .filter((record) => record.tenant_id === user.tenant_id)
    .filter((record) => !role || record.role === role)
    .filter((record) => !search || `${record.username} ${record.display_name}`.toLowerCase().includes(String(search).toLowerCase()))
    .map(publicUser);
  items.sort((a, b) => `${a.role}\u0000${a.username}`.localeCompare(`${b.role}\u0000${b.username}`));
  return { items, total: items.length };
}
function createUser(admin, body, ip = '') {
  if (!isAdmin(admin)) throw forbidden('只有系统管理员可以创建用户');
  const username = needText(body.username, 'username', { min: 3, max: 40 });
  if (!/^[A-Za-z][A-Za-z0-9_.-]+$/.test(username)) throw fieldError('username', '账号需以字母开头，仅含字母、数字、下划线、点和连字符');
  const displayName = needText(body.display_name, 'display_name', { min: 1, max: 40 });
  const password = needText(body.password, 'password', { min: 6, max: 128 });
  const role = ['admin', 'operator', 'repairer', 'finance', 'user'].includes(body.role) ? body.role : 'user';
  const communityIds = [...new Set(asList(body.community_ids))];
  for (const communityId of communityIds) ensureCommunity(admin, communityId);
  if (Object.values(state.users).some((record) => record.username.toLowerCase() === username.toLowerCase() && record.tenant_id === admin.tenant_id)) {
    throw conflict('用户名已存在', 'USERNAME_TAKEN');
  }
  const userId = nextId('users', 'U', 3);
  const record = {
    id: userId, tenant_id: admin.tenant_id, username, display_name: displayName, role,
    community_ids: communityIds, phone: String(body.phone || '').slice(0, 20),
    email: String(body.email || '').slice(0, 120), status: 'active',
    password_hash: hashPassword(password), created_at: iso(), last_login_at: null,
  };
  state.users[userId] = record;
  appendAudit({ action: 'create_user', actor: admin, targetType: 'user', targetId: userId, detail: `创建 ${username}（${role}）`, ip });
  return publicUser(record);
}
function updateUserStatus(admin, userId, body, ip = '') {
  if (!isAdmin(admin)) throw forbidden('只有系统管理员可以修改用户状态');
  if (admin.id === userId) throw badRequest('不能停用当前登录账号');
  const status = body.status;
  need(['active', 'disabled'].includes(status), 'status', '状态只能是 active 或 disabled');
  const record = getUser(userId);
  ensureTenantRecord(admin, record, '用户');
  record.status = status;
  appendAudit({ action: 'update_user_status', actor: admin, targetType: 'user', targetId: userId, detail: `状态改为 ${status}`, ip });
  return publicUser(record);
}

// --------------------------------------------------------------- communities
function listCommunities(user) {
  const allowed = new Set(scopedCommunities(user));
  const items = Object.values(state.communities)
    .filter((community) => community.tenant_id === user.tenant_id && allowed.has(community.id))
    .map(communityPublic);
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { items, total: items.length };
}
function createCommunity(admin, body, ip = '') {
  if (!isAdmin(admin)) throw forbidden('只有系统管理员可以创建社区');
  const communityId = nextId('communities', 'C', 3);
  const record = {
    id: communityId, tenant_id: admin.tenant_id, org_id: 'ORG001',
    name: needText(body.name, 'name', { min: 2, max: 60 }),
    address: needText(body.address, 'address', { min: 4, max: 160 }),
    city: String(body.city || '北京市').slice(0, 40), district: String(body.district || '').slice(0, 40),
    contact: String(body.contact || '').slice(0, 40), phone: String(body.phone || '').slice(0, 20),
    created_at: iso(),
  };
  state.communities[communityId] = record;
  appendAudit({ action: 'create_community', actor: admin, targetType: 'community', targetId: communityId, detail: record.name, ip });
  return communityPublic(record);
}
function listPiles(user, { status, communityId, search }) {
  expireStaleReservations();
  let items = [];
  for (const pile of pilesFor(user)) {
    if (status && pile.status !== status) continue;
    if (communityId && pile.community_id !== communityId) continue;
    if (search && !`${pile.code} ${pile.model} ${pile.connector}`.toLowerCase().includes(String(search).toLowerCase())) continue;
    items.push(pilePublic(pile));
  }
  items.sort((a, b) => {
    if (a.community_name < b.community_name) return -1;
    if (a.community_name > b.community_name) return 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return { items, total: items.length };
}
function getPileDetail(user, pileId) {
  const pile = getPile(pileId);
  ensurePileScope(user, pile);
  const result = pilePublic(pile);
  result.recent_events = sortDesc(Object.values(state.events).filter((event) => event.pile_id === pileId), 'occurred_at').slice(0, 8);
  result.open_tickets = Object.values(state.tickets).filter((ticket) => ticket.pile_id === pileId && TICKET_OPEN.has(ticket.status)).map(ticketPublic);
  return result;
}
function createPile(user, body, ip = '') {
  if (!canManage(user)) throw forbidden('只有管理员或运营人员可以新增设备');
  ensureCommunity(user, body.community_id);
  if (Object.values(state.piles).some((pile) => pile.code === body.code && pile.community_id === body.community_id)) {
    throw conflict('该社区内已存在相同设备编号', 'PILE_CODE_TAKEN');
  }
  const pileId = nextId('piles', 'P', 3);
  const current = new Date();
  const pile = {
    id: pileId, tenant_id: user.tenant_id, community_id: body.community_id,
    code: needText(body.code, 'code', { min: 2, max: 50 }),
    model: String(body.model || '邻里 AC7').slice(0, 60),
    connector: ['国标交流', '国标直流'].includes(body.connector) ? body.connector : '国标交流',
    power: round(asNumber(body.power, 'power'), 1), price: round(asNumber(body.price, 'price'), 2),
    status: 'available', faults: 0, last_seen: iso(current), temperature: 28, last_power: 0,
    today_kwh: 0, total_kwh: 0, firmware: 'v2.4.1', installed_at: iso(current), created_at: iso(current),
  };
  if (pile.power <= 0 || pile.power > 480) throw fieldError('power', '功率需在 0 至 480 kW 之间');
  if (pile.price <= 0 || pile.price > 10) throw fieldError('price', '电价需在 0 至 10 元/度之间');
  state.piles[pileId] = pile;
  appendAudit({ action: 'create_pile', actor: user, targetType: 'pile', targetId: pileId, detail: `${body.community_id} / ${pile.code}`, ip });
  return pilePublic(pile);
}
function listAssignees(user) {
  const communities = new Set(scopedCommunities(user));
  const items = Object.values(state.users)
    .filter((record) => record.tenant_id === user.tenant_id && record.role === 'repairer' && record.status === 'active')
    .filter((record) => isAdmin(user) || (record.community_ids || []).some((id) => communities.has(id)))
    .map((record) => ({ id: record.id, display_name: record.display_name, role: record.role, phone: record.phone || '', community_ids: [...(record.community_ids || [])] }));
  return { items, total: items.length };
}

// --------------------------------------------------------------------- audit
function listAudit(user, { limit, action, search }) {
  if (!['admin', 'operator'].includes(user.role)) throw forbidden('只有管理员和运营人员可以查看审计日志');
  let items = state.audit.filter((entry) => entry.tenant_id === user.tenant_id);
  if (user.role === 'operator') {
    items = items.filter((entry) => entry.actor_id === user.id || ['system', 'device-gateway'].includes(entry.actor_id) || entry.target_type !== 'auth');
  }
  if (action) items = items.filter((entry) => entry.action === action);
  if (search) {
    const needle = String(search).toLowerCase();
    items = items.filter((entry) => `${entry.actor_name} ${entry.action} ${entry.detail} ${entry.target_id}`.toLowerCase().includes(needle));
  }
  items = sortDesc(items, 'at').slice(0, limit);
  return { items, total: items.length };
}

// ------------------------------------------------------------------- reports
function buildTrend(user, days) {
  const keys = dateRange(days);
  const buckets = new Map(keys.map((key) => [key, { date: key, revenue: 0, orders: 0, kwh: 0 }]));
  for (const order of ordersFor(user)) {
    if (order.is_test) continue;
    if (!['completed', 'refunded'].includes(order.status)) continue;
    const key = cnDateKey(order.completed_at || order.created_at);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.revenue += Math.max(0, Number(order.amount || 0) - Number(order.refund_amount || 0));
    bucket.orders += 1;
    bucket.kwh += Number(order.kwh || 0);
  }
  return [...buckets.values()].map((bucket) => ({ ...bucket, revenue: money(bucket.revenue), kwh: round(bucket.kwh, 1) }));
}
function dashboard(user) {
  expireStaleReservations();
  const piles = pilesFor(user).map(pilePublic);
  const orders = ordersFor(user);
  const tickets = ticketsFor(user);
  const approvals = approvalsFor(user);
  const myOrders = orders.filter((order) => order.user_id === user.id);
  const today = startOfDay(0);
  const todayOrders = myOrders.filter((order) => (parseDt(order.created_at) || today) >= today);
  const todayRevenue = orders
    .filter((order) => order.status === 'completed' && (parseDt(order.completed_at) || today) >= today && !order.is_test)
    .reduce((sum, order) => sum + Math.max(0, Number(order.amount || 0) - Number(order.refund_amount || 0)), 0);
  const activeSessions = myOrders.filter((order) => order.status === 'charging');
  const upcoming = myOrders.filter((order) => order.status === 'reserved' && (parseDt(order.reserved_end) || new Date()) >= new Date());
  const personal = user.role === 'user';
  const kpis = {
    piles: piles.length,
    available: piles.filter((pile) => pile.status === 'available').length,
    charging: piles.filter((pile) => pile.status === 'charging').length,
    faults: piles.filter((pile) => ['fault', 'offline'].includes(pile.status)).length,
    availability_rate: pct(piles.filter((pile) => !PILE_BLOCKED.has(pile.status)).length, piles.length),
    orders_today: personal
      ? todayOrders.length
      : orders.filter((order) => (parseDt(order.created_at) || today) >= today && !order.is_test).length,
    revenue_today: money(todayRevenue),
    my_spend: money(myOrders.filter((order) => order.status === 'completed').reduce((sum, order) => sum + Number(order.amount || 0), 0)),
    open_tickets: tickets.filter((ticket) => TICKET_OPEN.has(ticket.status)).length,
    pending_approvals: approvals.filter((approval) => approval.status === 'pending').length,
    active_sessions: activeSessions.length,
    upcoming_reservations: upcoming.length,
  };
  const alerts = [];
  for (const pile of piles) {
    if (pile.status === 'fault') {
      alerts.push({ level: 'P1', type: 'device', title: `${pile.code} 设备故障`, detail: `已累计 ${pile.faults} 次故障，最后心跳 ${pile.last_seen_minutes.toFixed(0)} 分钟前`, target: pile.id });
    } else if (pile.status === 'offline') {
      alerts.push({ level: 'P1', type: 'device', title: `${pile.code} 设备离线`, detail: `最后心跳 ${pile.last_seen_minutes.toFixed(0)} 分钟前`, target: pile.id });
    }
  }
  for (const ticket of tickets) {
    if (TICKET_OPEN.has(ticket.status) && (parseDt(ticket.due_at) || new Date()) < new Date()) {
      alerts.push({ level: ticket.level, type: 'ticket', title: `${ticket.id} 工单超时`, detail: ticket.title, target: ticket.id });
    }
  }
  for (const approval of approvals) {
    if (approval.status === 'pending') alerts.push({ level: '审批', type: 'approval', title: `${approval.id} 待审批`, detail: approval.impact, target: approval.id });
  }
  const rank = { P1: 0, P2: 1, P3: 2, 审批: 3 };
  const sortedAlerts = [...alerts].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9)).slice(0, 6);
  const recentActivity = state.audit.filter((entry) => entry.tenant_id === user.tenant_id && (!personal || entry.actor_id === user.id)).slice(-6).reverse();
  const communityHealth = Object.values(state.communities)
    .filter((community) => community.tenant_id === user.tenant_id && scopedCommunities(user).includes(community.id))
    .map(communityPublic);
  return {
    personal,
    kpis,
    trend: buildTrend(user, 7),
    community_health: communityHealth,
    alerts: sortedAlerts,
    recent_activity: recentActivity,
    status_distribution: {
      available: kpis.available, charging: kpis.charging,
      fault: piles.filter((pile) => pile.status === 'fault').length,
      offline: piles.filter((pile) => pile.status === 'offline').length,
      maintenance: piles.filter((pile) => pile.status === 'maintenance').length,
      reserved: piles.filter((pile) => pile.status === 'reserved').length,
    },
    next_reservation: upcoming[0] || null,
    active_session: activeSessions[0] || null,
    generated_at: iso(),
  };
}
function operationsReport(user, days) {
  const windowDays = Math.max(1, Math.min(30, Number(days) || 7));
  if (user.role === 'user') throw forbidden('居民用户无权查看运营报表');
  expireStaleReservations();
  const orders = ordersFor(user).filter((order) => !order.is_test);
  const piles = pilesFor(user);
  const tickets = ticketsFor(user);
  const communities = Object.values(state.communities).filter((community) => community.tenant_id === user.tenant_id && scopedCommunities(user).includes(community.id));
  const since = startOfDay(windowDays - 1);
  const periodOrders = orders.filter((order) => (parseDt(order.completed_at || order.created_at) || since) >= since);
  const completed = periodOrders.filter((order) => ['completed', 'refunded'].includes(order.status));
  const revenue = completed.reduce((sum, order) => sum + Math.max(0, Number(order.amount || 0) - Number(order.refund_amount || 0)), 0);
  const refunds = periodOrders.reduce((sum, order) => sum + Number(order.refund_amount || 0), 0);
  const kwh = completed.reduce((sum, order) => sum + Number(order.kwh || 0), 0);
  const closed = tickets.filter((ticket) => ticket.status === 'closed' && ticket.closed_at);
  const mttrSeconds = closed.map((ticket) => (parseDt(ticket.closed_at) - parseDt(ticket.created_at)) / 1000).filter((value) => Number.isFinite(value));
  const available = piles.filter((pile) => !PILE_BLOCKED.has(pile.status));
  const totalPower = piles.reduce((sum, pile) => sum + Number(pile.power), 0) || 1;
  const utilization = pct(kwh, totalPower * 24 * windowDays);
  const attempts = Number(state.meta.reservation_attempts || 0);
  const successes = Number(state.meta.reservation_success || 0);
  const communityRows = communities.map((community) => {
    const communityOrders = completed.filter((order) => order.community_id === community.id);
    const communityPiles = piles.filter((pile) => pile.community_id === community.id);
    const communityTickets = tickets.filter((ticket) => ticket.community_id === community.id && TICKET_OPEN.has(ticket.status));
    return {
      id: community.id, name: community.name, piles: communityPiles.length,
      availability_rate: pct(communityPiles.filter((pile) => !PILE_BLOCKED.has(pile.status)).length, communityPiles.length),
      utilization: pct(communityOrders.reduce((sum, order) => sum + Number(order.kwh || 0), 0), (communityPiles.reduce((sum, pile) => sum + Number(pile.power), 0) || 1) * 24 * windowDays),
      revenue: money(communityOrders.reduce((sum, order) => sum + Math.max(0, Number(order.amount || 0) - Number(order.refund_amount || 0)), 0)),
      orders: communityOrders.length, open_tickets: communityTickets.length,
      faults: communityPiles.filter((pile) => ['fault', 'offline'].includes(pile.status)).length,
    };
  });
  communityRows.sort((a, b) => b.revenue - a.revenue);
  const levelCounts = { P1: 0, P2: 0, P3: 0 };
  for (const ticket of tickets) {
    if (TICKET_OPEN.has(ticket.status)) levelCounts[ticket.level] = (levelCounts[ticket.level] || 0) + 1;
  }
  const topFaults = piles
    .filter((pile) => Number(pile.faults) > 0)
    .map((pile) => ({ id: pile.id, code: pile.code, community_name: state.communities[pile.community_id]?.name || '', faults: pile.faults, status: pile.status }))
    .sort((a, b) => b.faults - a.faults)
    .slice(0, 6);
  return {
    period: { days: windowDays, from: iso(since), to: iso(), label: `近 ${windowDays} 天` },
    kpis: {
      total_piles: piles.length,
      availability_rate: pct(available.length, piles.length),
      utilization,
      fault_rate: pct(piles.filter((pile) => Number(pile.faults) > 0).length, piles.length),
      mttr_hours: mttrSeconds.length ? round(mttrSeconds.reduce((a, b) => a + b, 0) / mttrSeconds.length / 3600, 1) : 0,
      reservation_success_rate: attempts ? pct(successes, attempts) : 0,
      revenue: money(revenue), refund_amount: money(refunds), orders: completed.length, kwh: round(kwh, 1),
      avg_order_amount: completed.length ? money(revenue / completed.length) : 0,
      open_tickets: tickets.filter((ticket) => TICKET_OPEN.has(ticket.status)).length,
      pending_approvals: Object.values(state.approvals).filter((approval) => approval.tenant_id === user.tenant_id && approval.status === 'pending' && (canApprove(user) || approval.requester_id === user.id)).length,
    },
    trend: buildTrend(user, windowDays),
    communities: communityRows,
    ticket_levels: levelCounts,
    top_faults: topFaults,
    generated_at: iso(),
  };
}
function buildCsv(report) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [];
  const row = (...cells) => lines.push(cells.map(escape).join(','));
  row('邻里充电运营报表', report.period.label);
  row('生成时间', report.generated_at);
  row();
  row('核心指标', '数值');
  const labels = {
    total_piles: '设备总数', availability_rate: '设备可用率(%)', utilization: '设备利用率(%)',
    fault_rate: '故障率(%)', mttr_hours: '平均修复时长(小时)', reservation_success_rate: '预约成功率(%)',
    revenue: '净收入(元)', refund_amount: '退款金额(元)', orders: '完成订单', kwh: '充电量(度)',
    avg_order_amount: '客单价(元)', open_tickets: '未关闭工单', pending_approvals: '待审批',
  };
  for (const [key, label] of Object.entries(labels)) row(label, report.kpis[key]);
  row();
  row('日期', '收入(元)', '订单数', '充电量(度)');
  for (const item of report.trend) row(item.date, item.revenue, item.orders, item.kwh);
  row();
  row('社区', '设备数', '可用率(%)', '利用率(%)', '收入(元)', '订单数', '未关闭工单');
  for (const item of report.communities) row(item.name, item.piles, item.availability_rate, item.utilization, item.revenue, item.orders, item.open_tickets);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- agent chat
function agentFaults(user) {
  const communities = new Set(scopedCommunities(user));
  const piles = Object.values(state.piles).filter((pile) => pile.tenant_id === user.tenant_id && communities.has(pile.community_id));
  const tickets = Object.values(state.tickets).filter((ticket) => ticket.tenant_id === user.tenant_id && communities.has(ticket.community_id) && TICKET_OPEN.has(ticket.status) && (user.role !== 'user' || ticket.reporter_id === user.id));
  const faults = piles.filter((pile) => ['fault', 'offline'].includes(pile.status));
  if (!faults.length && !tickets.length) {
    return ['当前授权范围内没有故障设备或未关闭工单，设备健康度良好。', [{ name: '设备台账', table: 'charging_piles', count: piles.length }], ['查看今日运营指标', '哪些桩可用？']];
  }
  const faultText = faults.map((pile) => `${pile.code}（${pile.status}，累计 ${pile.faults} 次）`).join('、') || '无故障桩';
  const overdue = tickets.filter((ticket) => (parseDt(ticket.due_at) || new Date()) < new Date()).length;
  const p1 = tickets.filter((ticket) => ticket.level === 'P1').length;
  const topTicket = [...tickets].sort((a, b) => (a.level < b.level ? -1 : a.level > b.level ? 1 : 0))[0];
  let answer = `当前授权范围内有 ${faults.length} 台故障/离线设备：${faultText}；未关闭工单 ${tickets.length} 张（P1 ${p1} 张，超时 ${overdue} 张）。`;
  if (topTicket) answer += `建议优先处理 ${topTicket.id}「${topTicket.title}」，先核验心跳，再按维修流程回填。`;
  answer += '高风险停机操作只能提交审批，审批通过后执行。';
  return [answer, [{ name: '设备台账', table: 'charging_piles', count: piles.length }, { name: '维修工单', table: 'repair_tickets', count: tickets.length }], ['查看待审批申请', '查看工单池', '分析设备可用率']];
}
function agentAvailable(user) {
  const communities = new Set(scopedCommunities(user));
  const piles = Object.values(state.piles)
    .filter((pile) => pile.tenant_id === user.tenant_id && communities.has(pile.community_id) && pile.status === 'available')
    .sort((a, b) => `${a.community_id}${a.code}`.localeCompare(`${b.community_id}${b.code}`));
  if (!piles.length) return ['当前授权范围内没有空闲充电桩，建议查看预约队列或稍后重试。', [{ name: '实时设备状态', table: 'charging_piles', count: 0 }], ['查看故障设备', '查看我的订单']];
  const lines = piles.slice(0, 6).map((pile) => `${pile.code}（${state.communities[pile.community_id]?.name || ''}，${pile.power}kW，¥${fmt2(pile.price)}/度）`);
  let answer = `当前有 ${piles.length} 台空闲充电桩：${lines.join('；')}。`;
  if (piles.length > 6) answer += `另有 ${piles.length - 6} 台未展示。`;
  answer += ' 可在「充电设备」页直接预约。';
  return [answer, [{ name: '实时设备状态', table: 'charging_piles', count: piles.length }], ['帮我预约', '查看电价', '分析设备可用率']];
}
function agentRevenue(user) {
  if (user.role === 'user') {
    const orders = ordersFor(user).filter((order) => order.status === 'completed');
    const spent = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    return [
      `你共有 ${orders.length} 笔已完成充电，累计消费 ¥${fmt2(spent)}。最近一笔为 ${orders.length ? orders[orders.length - 1].id : '—'}。`,
      [{ name: '我的订单', table: 'charging_orders', count: orders.length }],
      ['查看我的订单', '申请退款', '哪些桩可用？'],
    ];
  }
  const report = operationsReport(user, 7);
  const kpis = report.kpis;
  const top = report.communities[0] || null;
  let answer = `近 7 天完成 ${kpis.orders} 笔订单，净收入 ¥${fmt2(kpis.revenue)}，退款 ¥${fmt2(kpis.refund_amount)}，客单价 ¥${fmt2(kpis.avg_order_amount)}，充电量 ${kpis.kwh} 度。`;
  if (top) answer += `收入最高的是${top.name}（¥${fmt2(top.revenue)}）。`;
  answer += '退款必须走审批，Agent 不会直接改账。';
  return [answer, [{ name: '订单流水', table: 'charging_orders', count: kpis.orders }, { name: '社区维度汇总', table: 'communities', count: report.communities.length }], ['查看待审批', '分析设备可用率', '看看故障工单']];
}
function agentTickets(user) {
  if (user.role === 'user') {
    const tickets = Object.values(state.tickets).filter((ticket) => ticket.reporter_id === user.id);
    if (!tickets.length) return ['你还没有提交过报修工单。可在设备详情中提交报修。', [{ name: '我的工单', table: 'repair_tickets', count: 0 }], ['哪些桩可用？']];
    const latest = sortDesc(tickets, 'created_at')[0];
    return [`你共有 ${tickets.length} 张工单，最近一张 ${latest.id}「${latest.title}」当前状态为 ${latest.status}。`, [{ name: '我的工单', table: 'repair_tickets', count: tickets.length }], ['查看设备', '申请退款']];
  }
  const communities = new Set(scopedCommunities(user));
  const tickets = Object.values(state.tickets).filter((ticket) => ticket.tenant_id === user.tenant_id && communities.has(ticket.community_id));
  const openTickets = tickets.filter((ticket) => TICKET_OPEN.has(ticket.status));
  const overdue = openTickets.filter((ticket) => (parseDt(ticket.due_at) || new Date()) < new Date());
  const byLevel = { P1: 0, P2: 0, P3: 0 };
  for (const ticket of openTickets) byLevel[ticket.level] = (byLevel[ticket.level] || 0) + 1;
  let answer = `共有 ${openTickets.length} 张未关闭工单：P1 ${byLevel.P1}、P2 ${byLevel.P2}、P3 ${byLevel.P3}；其中超时 ${overdue.length} 张。`;
  if (openTickets.length) {
    const first = [...openTickets].sort((a, b) => `${a.level}${a.created_at}`.localeCompare(`${b.level}${b.created_at}`))[0];
    answer += `最早的高优工单是 ${first.id}「${first.title}」。`;
  }
  return [answer, [{ name: '维修工单', table: 'repair_tickets', count: openTickets.length }], ['分派工单', '查看设备', '查看待审批']];
}
function agentApprovals(user) {
  const communities = new Set(scopedCommunities(user));
  const items = Object.values(state.approvals).filter((approval) => {
    if (approval.tenant_id !== user.tenant_id || approval.status !== 'pending') return false;
    if (user.role === 'user' && approval.requester_id !== user.id) return false;
    if (!['user', 'admin', 'finance'].includes(user.role)) {
      if (approval.requester_id !== user.id && !communities.has(approval.payload?.community_id)) return false;
    }
    return true;
  });
  if (!items.length) return ['当前没有待处理的审批申请。', [{ name: '审批中心', table: 'approvals', count: 0 }], ['查看运营指标', '分析故障']];
  const lines = items.slice(0, 5).map((approval) => `${approval.id} ${approval.title}（${approval.impact}，申请人 ${approval.requester_name}）`);
  return [`当前有 ${items.length} 条待审批申请：${lines.join('；')}。审批通过后才会执行实际变更。`, [{ name: '审批中心', table: 'approvals', count: items.length }], ['查看运营指标', '分析故障']];
}
function agentMetrics(user) {
  if (user.role !== 'user') {
    const kpis = operationsReport(user, 7).kpis;
    const answer = `近 7 天设备可用率 ${kpis.availability_rate}%，利用率 ${kpis.utilization}%，故障率 ${kpis.fault_rate}%，平均修复时长 ${kpis.mttr_hours} 小时，预约成功率 ${kpis.reservation_success_rate}%。 可用率 = 非故障/离线/维护设备 ÷ 设备总数；利用率 = 充电量 ÷（额定功率 × 时长）。`;
    return [answer, [{ name: '运营指标', table: 'charging_orders', count: kpis.orders }], ['查看运营报表', '分析故障', '查看收入']];
  }
  const communities = new Set(scopedCommunities(user));
  const piles = Object.values(state.piles).filter((pile) => pile.tenant_id === user.tenant_id && communities.has(pile.community_id));
  const available = piles.filter((pile) => pile.status === 'available').length;
  return [`你所在社区共有 ${piles.length} 台设备，其中 ${available} 台当前可用。 如需查看完整运营指标，请使用运营或财务账号。`, [{ name: '实时设备状态', table: 'charging_piles', count: piles.length }], ['哪些桩可用？', '查看我的订单']];
}
function agentPrices(user) {
  const communities = new Set(scopedCommunities(user));
  const piles = Object.values(state.piles).filter((pile) => pile.tenant_id === user.tenant_id && communities.has(pile.community_id));
  const grouped = new Map();
  for (const pile of piles) {
    if (!grouped.has(pile.community_id)) grouped.set(pile.community_id, new Set());
    grouped.get(pile.community_id).add(Number(pile.price));
  }
  const parts = [...grouped.entries()].map(([communityId, prices]) => `${state.communities[communityId]?.name || communityId} ${[...prices].sort((a, b) => a - b).map((price) => `¥${fmt2(price)}/度`).join(' / ')}`);
  return [`当前电价：${parts.join('；')}。电价调整属于高风险动作，必须提交审批。`, [{ name: '计费规则', table: 'charging_piles', count: piles.length }], ['申请调价', '哪些桩可用？']];
}
function agentHelp() {
  return [
    '我可以：① 查询可用充电桩和电价；② 分析故障、工单和运营指标；③ 查询收入与待审批；④ 创建普通维修工单；⑤ 为退款、停机、调价、批量改派创建审批申请。涉及资金或设备状态的高风险动作只生成审批，不会直接执行。',
    [],
    ['当前有哪些可用充电桩？', '分析当前故障和维修情况', '近 7 天运营指标', '为订单 O1005 申请退款 18.6 元'],
  ];
}
function findPile(text, communities) {
  const match = /P\d{3}/i.exec(text.toUpperCase());
  if (match) {
    const pile = state.piles[match[0]];
    return pile && communities.has(pile.community_id) ? pile : null;
  }
  const normalized = text.replace(/\s+/g, '');
  for (const pile of Object.values(state.piles)) {
    const code = String(pile.code).replace(/\s+/g, '');
    if (code && normalized.includes(code) && communities.has(pile.community_id)) return pile;
  }
  return null;
}
function agentCreateTicketIntent(user, message) {
  if (!CREATE_TICKET_WORDS.some((word) => message.includes(word))) return null;
  const communities = new Set(scopedCommunities(user));
  const pile = findPile(message, communities);
  if (!pile) return ['请提供要报修的充电桩编号，例如「为 P003 创建工单，枪头无法锁止」。', [], ['分析当前故障']];
  const match = /工单[，,：: ]*(.{4,40})/.exec(message);
  const title = (match ? match[1].trim() : `${pile.code} 现场报修`).slice(0, 60);
  try {
    const ticket = createTicket(user, { pile_id: pile.id, title, description: sanitizeText(message), level: 'P2' }, 'agent');
    return [`已创建维修工单 ${ticket.id}「${ticket.title}」，当前状态为待处理。`, [{ name: '维修工单', table: 'repair_tickets', count: 1 }], ['查看工单池', '分析故障']];
  } catch (error) {
    const messageText = error instanceof ApiError ? error.message : '参数不合法';
    return [`工单创建失败：${messageText}`, [], []];
  }
}
function agentHighRisk(user, message) {
  const communities = new Set(scopedCommunities(user));
  if (message.includes('退款')) {
    const match = /O\d{4,}/i.exec(message.toUpperCase());
    if (!match) {
      const candidates = ordersFor(user).filter((order) => order.status === 'completed' && Number(order.amount || 0) > 0);
      const latest = sortDesc(candidates, 'completed_at')[0];
      const hint = latest ? `（例如最近完成的订单 ${latest.id}）` : '';
      return ['needs_clarification', `退款需要指定订单编号${hint}。请提供订单号和退款金额，我会创建审批申请，审批通过后才会退回。`, [{ name: '订单流水', table: 'charging_orders', count: candidates.length }], ['查看我的订单'], null];
    }
    const orderId = match[0];
    const order = state.orders[orderId];
    if (!order) return ['needs_clarification', `没有找到订单 ${orderId}，请核对订单编号。`, [], [], null];
    if (order.tenant_id !== user.tenant_id || (user.role === 'user' && order.user_id !== user.id)) return ['denied', '你无权为该订单申请退款。', [], [], null];
    const amountMatch = /(\d+(?:\.\d{1,2})?)\s*元/.exec(message);
    const remaining = money(Number(order.amount || 0) - Number(order.refund_amount || 0));
    const amount = amountMatch ? round(Number(amountMatch[1]), 2) : remaining;
    try {
      const approval = createApproval(user, { type: 'refund', reason: sanitizeText(message.slice(0, 400)), payload: { order_id: orderId, amount }, amount }, null, 'agent');
      return [
        'pending_approval',
        `已创建退款审批 ${approval.id}：订单 ${orderId}，退款 ¥${fmt2(amount)}，当前状态为待审批。审批通过前不会发生任何资金变更；可在「审批中心」查看影响范围和风险因素。`,
        [{ name: '审批中心', table: 'approvals', count: 1 }, { name: '订单流水', table: 'charging_orders', count: 1 }],
        ['查看待审批', '查看订单'], approval,
      ];
    } catch (error) {
      return ['denied', `退款申请未创建：${error.message || '参数不合法'}`, [], [], null];
    }
  }
  if (message.includes('停机') || message.includes('下线')) {
    if (!canManage(user)) return ['denied', '当前角色没有停机权限，只有管理员或运营人员可以提交停机审批。', [], [], null];
    const pile = findPile(message, communities);
    if (!pile) return ['needs_clarification', '请提供要停机的充电桩编号，例如「暂停 P003 检修 8 小时」。', [], [], null];
    const hoursMatch = /(\d+)\s*小时/.exec(message);
    const hours = hoursMatch ? Number.parseInt(hoursMatch[1], 10) : 8;
    try {
      const approval = createApproval(user, { type: 'stop_pile', reason: sanitizeText(message.slice(0, 400)), payload: { pile_id: pile.id, duration_hours: hours }, amount: 0 }, null, 'agent');
      return [
        'pending_approval',
        `已创建停机审批 ${approval.id}：${pile.code} 停机 ${hours} 小时。审批通过后才会执行，当前设备状态未改变。`,
        [{ name: '审批中心', table: 'approvals', count: 1 }, { name: '设备台账', table: 'charging_piles', count: 1 }],
        ['查看待审批', '分析故障'], approval,
      ];
    } catch (error) {
      return ['denied', `停机申请未创建：${error.message || '参数不合法'}`, [], [], null];
    }
  }
  if (message.includes('调价') || message.includes('改价') || message.includes('价格调整')) {
    if (!canManage(user)) return ['denied', '当前角色没有调价权限，只有管理员或运营人员可以提交调价审批。', [], [], null];
    const priceMatch = /(\d+(?:\.\d{1,2})?)\s*元/.exec(message);
    if (!priceMatch) return ['needs_clarification', '请提供目标社区和新的电价，例如「把阳光花园电价调到 1.5 元」。', [], [], null];
    const newPrice = round(Number(priceMatch[1]), 2);
    const community = Object.values(state.communities).find((item) => item.tenant_id === user.tenant_id && message.includes(item.name));
    if (!community) {
      const names = Object.values(state.communities).filter((item) => communities.has(item.id)).map((item) => item.name);
      return ['needs_clarification', `请指定社区名称（${names.join('、')}），例如「把阳光花园电价调到 1.5 元」。`, [], [], null];
    }
    try {
      const approval = createApproval(user, { type: 'price_change', reason: sanitizeText(message.slice(0, 400)), payload: { community_id: community.id, new_price: newPrice }, amount: 0 }, null, 'agent');
      return [
        'pending_approval',
        `已创建调价审批 ${approval.id}：${community.name} 电价调整为 ¥${fmt2(newPrice)}/度。审批通过后统一执行，当前价格未改变。`,
        [{ name: '审批中心', table: 'approvals', count: 1 }, { name: '计费规则', table: 'charging_piles', count: 1 }],
        ['查看待审批', '查看电价'], approval,
      ];
    } catch (error) {
      return ['denied', `调价申请未创建：${error.message || '参数不合法'}`, [], [], null];
    }
  }
  if (message.includes('批量')) {
    return ['needs_clarification', '批量改派需要明确工单编号与维修人员。请在「审批中心」发起批量改派，或告诉我工单号和维修人员姓名，我会创建审批申请。', [], ['查看工单池'], null];
  }
  return ['needs_clarification', '请说明需要审批的动作和目标对象。', [], [], null];
}
function handleChat(user, body, ip = '') {
  const started = Date.now();
  const nodes = [];
  const node = (name, status, detail, nodeStarted) => nodes.push({ node: name, status, detail, duration_ms: Math.max(1, Date.now() - nodeStarted) });
  const message = sanitizeText(needText(body.message, 'message', { min: 1, max: 1000 }));
  let cursor = Date.now();
  node('parse_intent', 'ok', '识别自然语言意图', cursor);

  cursor = Date.now();
  let threadId = body.thread_id || '';
  let thread = null;
  if (threadId && state.threads[threadId]) {
    thread = state.threads[threadId];
    if (thread.user_id !== user.id || thread.tenant_id !== user.tenant_id) throw forbidden('无权访问该会话', 'THREAD_FORBIDDEN');
  } else if (threadId) {
    throw forbidden('无权访问该会话', 'THREAD_FORBIDDEN');
  }
  if (!threadId) threadId = `TH${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  node('load_context', 'ok', `加载租户/社区数据范围与会话 ${threadId}`, cursor);

  cursor = Date.now();
  node('check_permission', 'ok', `角色 ${user.role}，数据范围 ${scopedCommunities(user).length} 个社区`, cursor);

  const risky = HIGH_RISK_WORDS.some((word) => message.includes(word));
  let status = 'completed';
  let approval = null;
  let plan = [];
  let suggestions = [];
  let sources = [];
  let ticketResult = null;
  let intent = 'help';
  let answer = '';

  if (risky) {
    cursor = Date.now();
    node('plan_action', 'ok', '识别为高风险动作，进入审批门', cursor);
    cursor = Date.now();
    node('risk_gate', 'blocked', '高风险动作禁止直接执行，必须人工审批', cursor);
    [status, answer, sources, suggestions, approval] = agentHighRisk(user, message);
    if (message.includes('退款')) intent = 'refund_request';
    else if (message.includes('停机') || message.includes('下线')) intent = 'stop_request';
    else if (message.includes('调价') || message.includes('改价') || message.includes('价格调整')) intent = 'price_change_request';
    else intent = 'batch_request';
    plan = [{ step: 'request_approval', risk: 'high', executed: false }];
    cursor = Date.now();
    node('request_approval', approval ? 'ok' : 'needs_input', '创建审批申请，不执行实际变更', cursor);
  } else {
    ticketResult = agentCreateTicketIntent(user, message);
    if (ticketResult) {
      [answer, sources, suggestions] = ticketResult;
      intent = 'create_ticket';
      status = answer.includes('已创建') ? 'completed' : 'needs_clarification';
      plan = [{ step: 'create_ticket', risk: 'medium', executed: status === 'completed' }];
      cursor = Date.now();
      node('plan_action', 'ok', '普通写操作：创建维修工单', cursor);
      cursor = Date.now();
      node('risk_gate', 'ok', '普通写：幂等执行并记录审计', cursor);
      cursor = Date.now();
      node('execute_action', status === 'completed' ? 'ok' : 'failed', '执行受控工具', cursor);
    } else {
      let result;
      if (FAULT_WORDS.some((word) => message.includes(word))) { intent = 'fault_analysis'; result = agentFaults(user); }
      else if (APPROVAL_WORDS.some((word) => message.includes(word))) { intent = 'approval_query'; result = agentApprovals(user); }
      else if (TICKET_WORDS.some((word) => message.includes(word))) { intent = 'ticket_query'; result = agentTickets(user); }
      else if (REVENUE_WORDS.some((word) => message.includes(word))) { intent = 'revenue_analysis'; result = agentRevenue(user); }
      else if (METRIC_WORDS.some((word) => message.toLowerCase().includes(word.toLowerCase()))) { intent = 'metric_explain'; result = agentMetrics(user); }
      else if (PRICE_WORDS.some((word) => message.includes(word))) { intent = 'price_query'; result = agentPrices(user); }
      else if (AVAILABLE_WORDS.some((word) => message.includes(word))) { intent = 'available_piles'; result = agentAvailable(user); }
      else { intent = 'help'; result = agentHelp(); }
      [answer, sources, suggestions] = result;
      plan = [{ step: 'read_only_tool', risk: 'low', executed: true }];
      cursor = Date.now();
      node('plan_action', 'ok', `选择只读工具 ${intent}`, cursor);
      cursor = Date.now();
      node('risk_gate', 'ok', '只读查询，无需审批', cursor);
      cursor = Date.now();
      node('execute_action', 'ok', '在授权数据范围内执行查询', cursor);
    }
  }

  cursor = Date.now();
  node('verify_result', 'ok', '校验返回字段与数据来源', cursor);
  cursor = Date.now();

  const response = {
    answer, intent,
    risk: risky ? 'high' : (ticketResult ? 'medium' : 'low'),
    status, requires_approval: risky,
    approval_id: approval ? approval.id : null,
    approval,
    data_sources: sources, plan, nodes, suggestions,
    thread_id: threadId, trace_id: traceId(),
    engine: 'local-tool-orchestrator', llm_used: false, generated_at: iso(),
  };

  let writable = state.threads[threadId];
  if (!writable) {
    writable = {
      id: threadId, tenant_id: user.tenant_id, user_id: user.id,
      title: message.slice(0, 32) || '新的运营会话', messages: [],
      created_at: iso(), updated_at: iso(),
    };
    state.threads[threadId] = writable;
  }
  writable.messages.push({ role: 'user', content: message, at: iso() });
  writable.messages.push({
    role: 'agent', content: answer, at: iso(),
    meta: { trace_id: response.trace_id, risk: response.risk, status, approval_id: response.approval_id },
  });
  writable.messages = writable.messages.slice(-20);
  writable.updated_at = iso();
  state.meta.agent_runs = Number(state.meta.agent_runs || 0) + 1;
  appendAudit({ action: 'agent_chat', actor: user, targetType: 'agent', targetId: threadId, detail: { intent, risk: response.risk, status, message: message.slice(0, 200) }, ip });
  node('write_memory', 'ok', '写入会话记忆与审计回执', cursor);
  node('reflect', 'ok', `总耗时 ${Date.now() - started} ms`, Date.now());
  response.duration_ms = Math.max(1, Date.now() - started);
  return response;
}
function listThreads(user) {
  const items = Object.values(state.threads)
    .filter((thread) => thread.tenant_id === user.tenant_id && thread.user_id === user.id)
    .map((thread) => ({
      id: thread.id, title: thread.title, updated_at: thread.updated_at,
      message_count: thread.messages.length,
      last_message: thread.messages.length ? thread.messages[thread.messages.length - 1].content.slice(0, 80) : '',
    }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { items, total: items.length };
}
function getThread(user, threadId) {
  const thread = state.threads[threadId];
  if (!thread || thread.tenant_id !== user.tenant_id || thread.user_id !== user.id) throw notFound('会话不存在');
  return thread;
}
function agentPolicy() {
  return {
    engine: 'local-tool-orchestrator', llm_used: false,
    tools: [
      { name: 'query_available_piles', risk: 'low', scope: '授权社区' },
      { name: 'analyze_faults', risk: 'low', scope: '授权社区' },
      { name: 'query_orders', risk: 'low', scope: '本人/授权社区' },
      { name: 'query_tickets', risk: 'low', scope: '本人/授权社区' },
      { name: 'create_ticket', risk: 'medium', scope: '授权设备' },
      { name: 'request_refund', risk: 'high', mode: 'approval_only' },
      { name: 'request_stop_pile', risk: 'high', mode: 'approval_only' },
      { name: 'request_price_change', risk: 'high', mode: 'approval_only' },
      { name: 'request_batch_reassign', risk: 'high', mode: 'approval_only' },
    ],
    rules: ['高风险动作只创建审批申请，不执行实际变更', '工具参数由服务端校验，模型不能生成 SQL 或系统命令', '所有回答附带数据来源、执行节点和 trace_id', '居民用户只能查询本人订单和社区设备'],
    trace_id: traceId(),
  };
}

// ------------------------------------------------------------------- system
function health() {
  return {
    status: 'ok', service: 'neighbor-charge-agent', version: APP_VERSION,
    mode: DEMO_MODE ? 'demo' : 'production',
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    checks: {
      api: { status: 'ok' },
      storage: { status: 'ok', backend: 'memory', writable: true, last_saved_at: iso(), last_error: null },
    },
    records: { users: Object.keys(state.users).length, piles: Object.keys(state.piles).length, orders: Object.keys(state.orders).length, tickets: Object.keys(state.tickets).length },
    generated_at: iso(), trace_id: traceId(),
  };
}
function meta() {
  return {
    app: { name: APP_NAME, version: APP_VERSION, mode: DEMO_MODE ? 'demo' : 'production', serverless: true },
    labels: { roles: ROLE_LABELS, pile_status: PILE_STATUS_LABELS, ticket_status: TICKET_STATUS_LABELS, order_status: ORDER_STATUS_LABELS },
    limits: { max_reservation_hours: MAX_RESERVATION_HOURS, heartbeat_fresh_minutes: HEARTBEAT_FRESH_MINUTES },
    server_time: iso(),
  };
}

// -------------------------------------------------------------------- routes
const traced = (payload) => (payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload, trace_id: traceId() } : payload);

function login(ctx) {
  const { body, req } = ctx;
  const username = needText(body.username, 'username', { min: 1, max: 64 });
  const password = needText(body.password, 'password', { min: 1, max: 128 });
  const ip = requestIp(req);
  const key = `${username.toLowerCase()}|${ip}`;
  checkLoginRate(key);
  const user = Object.values(state.users).find((record) => record.username.toLowerCase() === username.toLowerCase() && record.status === 'active');
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(key);
    if (user) {
      appendAudit({ action: 'login_failed', actorId: user.id, actorName: user.display_name, actorRole: user.role, targetType: 'auth', targetId: user.id, detail: '用户名或密码错误', ip, tenantId: user.tenant_id });
    }
    throw unauthorized('用户名或密码错误', 'INVALID_CREDENTIALS');
  }
  LOGIN_ATTEMPTS.delete(key);
  const issued = issueToken(user);
  const payload = { ...publicUser(user), token_exp: issued.exp };
  user.last_login_at = iso();
  state.meta.login_count = Number(state.meta.login_count || 0) + 1;
  appendAudit({ action: 'login', actor: user, targetType: 'auth', targetId: user.id, detail: '登录运营平台', ip });
  return {
    access_token: issued.token, token_type: 'bearer', expires_in: issued.ttl,
    expires_at: issued.exp, user: payload, trace_id: traceId(),
  };
}
function me(ctx) {
  return { user: ctx.user, trace_id: traceId() };
}
function refresh(ctx) {
  const user = ctx.user;
  const issued = issueToken({ id: user.id, tenant_id: user.tenant_id, role: user.role, display_name: user.display_name });
  revokeToken(user.jti, user.token_exp);
  return { access_token: issued.token, token_type: 'bearer', expires_in: issued.ttl, trace_id: traceId() };
}
function logout(ctx) {
  revokeToken(ctx.user.jti, ctx.user.token_exp);
  appendAudit({ action: 'logout', actor: ctx.user, targetType: 'auth', targetId: ctx.user.id, detail: '退出登录' });
  return { ok: true, trace_id: traceId() };
}
function demoAccounts() {
  if (!DEMO_MODE) return { password: '', items: [], notice: '生产环境不提供演示账号列表。' };
  const items = [];
  for (const username of ['admin', 'operator', 'repairer', 'finance', 'user']) {
    const record = Object.values(state.users).find((item) => item.username === username && item.tenant_id === 'T001');
    if (record) items.push({ username: record.username, display_name: record.display_name, role: record.role, role_label: ROLE_LABELS[record.role] || record.role });
  }
  return { password: DEMO_PASSWORD, items, notice: '演示环境账号，仅用于本地与预览部署。' };
}
function csvResponse(ctx) {
  const report = operationsReport(ctx.user, ctx.query.get('days') || 7);
  const filename = `neighbor-charge-report-${iso().slice(0, 10).replace(/-/g, '')}.csv`;
  const body = '\uFEFF' + buildCsv(report);
  appendAudit({ action: 'report_export', actor: ctx.user, targetType: 'report', targetId: `operations:${report.period.days}`, detail: `导出近 ${report.period.days} 天运营报表`, ip: requestIp(ctx.req) });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  });
}
function deviceActor(req) {
  const key = req.headers.get('x-device-key');
  if (key) {
    const left = Buffer.from(key);
    const right = Buffer.from(DEVICE_API_KEY);
    if (left.length === right.length && crypto.timingSafeEqual(left, right)) {
      return { id: 'device-gateway', tenant_id: 'T001', role: 'system', display_name: '设备网关', community_ids: ['C001', 'C002', 'C003'] };
    }
    throw unauthorized('设备接入密钥无效', 'DEVICE_KEY_INVALID');
  }
  return currentUser(req);
}

const ROUTES = [
  { method: 'POST', re: /^\/api\/auth\/login$/, auth: false, handler: login },
  { method: 'GET', re: /^\/api\/auth\/me$/, handler: me },
  { method: 'POST', re: /^\/api\/auth\/logout$/, handler: logout },
  { method: 'POST', re: /^\/api\/auth\/refresh$/, handler: refresh },
  { method: 'GET', re: /^\/api\/auth\/demo-accounts$/, auth: false, handler: demoAccounts },
  { method: 'GET', re: /^\/api\/health$/, auth: false, handler: health },
  { method: 'GET', re: /^\/api\/meta$/, auth: false, handler: meta },
  { method: 'GET', re: /^\/api\/version$/, auth: false, handler: () => ({ version: APP_VERSION, mode: DEMO_MODE ? 'demo' : 'production', time: iso() }) },
  { method: 'GET', re: /^\/api\/dashboard$/, handler: (ctx) => traced(dashboard(ctx.user)) },
  { method: 'GET', re: /^\/api\/reports\/operations\.csv$/, roles: ['admin', 'operator', 'finance'], handler: csvResponse },
  { method: 'GET', re: /^\/api\/reports\/operations$/, roles: ['admin', 'operator', 'repairer', 'finance'], handler: (ctx) => traced(operationsReport(ctx.user, ctx.query.get('days') || 7)) },
  { method: 'GET', re: /^\/api\/communities$/, handler: (ctx) => listCommunities(ctx.user) },
  { method: 'POST', re: /^\/api\/communities$/, status: 201, handler: (ctx) => createCommunity(ctx.user, ctx.body, requestIp(ctx.req)) },
  { method: 'GET', re: /^\/api\/piles$/, handler: (ctx) => listPiles(ctx.user, { status: ctx.query.get('status'), communityId: ctx.query.get('community_id'), search: ctx.query.get('search') || '' }) },
  { method: 'POST', re: /^\/api\/piles$/, status: 201, handler: (ctx) => createPile(ctx.user, ctx.body, requestIp(ctx.req)) },
  { method: 'GET', re: /^\/api\/piles\/([^/]+)$/, handler: (ctx) => getPileDetail(ctx.user, ctx.params[0]) },
  { method: 'GET', re: /^\/api\/assignees$/, roles: ['admin', 'operator'], handler: (ctx) => listAssignees(ctx.user) },
  { method: 'GET', re: /^\/api\/orders$/, handler: (ctx) => traced(listOrders(ctx.user, {
    status: ctx.query.get('status'), communityId: ctx.query.get('community_id'), search: ctx.query.get('search') || '',
    page: Math.max(1, Number.parseInt(ctx.query.get('page') || '1', 10) || 1),
    pageSize: Math.min(100, Math.max(5, Number.parseInt(ctx.query.get('page_size') || '20', 10) || 20)),
  })) },
  { method: 'GET', re: /^\/api\/orders\/([^/]+)$/, handler: (ctx) => traced(getOrderDetail(ctx.user, ctx.params[0])) },
  { method: 'POST', re: /^\/api\/orders\/([^/]+)\/start$/, handler: (ctx) => traced(startOrder(ctx.user, ctx.params[0], requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/orders\/([^/]+)\/complete$/, handler: (ctx) => traced(completeOrder(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/orders\/([^/]+)\/cancel$/, handler: (ctx) => traced(cancelOrder(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/reservations$/, handler: (ctx) => traced(listReservations(ctx.user)) },
  { method: 'POST', re: /^\/api\/reservations$/, status: 201, roles: ['admin', 'operator', 'user'], handler: (ctx) => traced(createReservation(ctx.user, ctx.body, idempotencyKey(ctx.req), requestIp(ctx.req))) },
  { method: 'DELETE', re: /^\/api\/reservations\/([^/]+)$/, handler: (ctx) => traced(cancelReservation(ctx.user, ctx.params[0], '用户取消预约', requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/refunds$/, status: 202, handler: (ctx) => traced(requestRefund(ctx.user, ctx.body, requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/events$/, roles: ['admin', 'operator', 'repairer'], handler: (ctx) => listEvents(ctx.user, Math.min(200, Math.max(1, Number.parseInt(ctx.query.get('limit') || '50', 10) || 50))) },
  { method: 'POST', re: /^\/api\/device-events$/, status: 202, auth: 'device', handler: (ctx) => traced(ingestDeviceEvent(ctx.user, ctx.body, requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/tickets$/, roles: ['admin', 'operator', 'repairer', 'user'], handler: (ctx) => traced(listTickets(ctx.user, { status: ctx.query.get('status'), level: ctx.query.get('level'), communityId: ctx.query.get('community_id') })) },
  { method: 'POST', re: /^\/api\/tickets$/, status: 201, handler: (ctx) => traced(createTicket(ctx.user, ctx.body, requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/tickets\/([^/]+)$/, handler: (ctx) => traced(getTicketDetail(ctx.user, ctx.params[0])) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/assign$/, roles: ['admin', 'operator'], handler: (ctx) => traced(assignTicket(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/accept$/, roles: ['admin', 'repairer'], handler: (ctx) => traced(acceptTicket(ctx.user, ctx.params[0], requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/resolve$/, roles: ['admin', 'operator', 'repairer'], handler: (ctx) => traced(resolveTicket(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/test-order$/, roles: ['admin', 'operator', 'repairer'], handler: (ctx) => traced(createTestOrder(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/heartbeat$/, roles: ['admin', 'operator', 'repairer'], handler: (ctx) => traced(simulateHeartbeat(ctx.user, ctx.params[0], requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/close$/, roles: ['admin', 'operator', 'repairer'], handler: (ctx) => traced(closeTicket(ctx.user, ctx.params[0], requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/approvals$/, handler: (ctx) => traced(listApprovals(ctx.user, { status: ctx.query.get('status'), type: ctx.query.get('type') })) },
  { method: 'POST', re: /^\/api\/approvals$/, status: 201, handler: (ctx) => traced(createApproval(ctx.user, ctx.body, idempotencyKey(ctx.req), requestIp(ctx.req))) },
  { method: 'GET', re: /^\/api\/approvals\/([^/]+)$/, handler: (ctx) => traced(getApprovalDetail(ctx.user, ctx.params[0])) },
  { method: 'POST', re: /^\/api\/approvals\/([^/]+)\/decision$/, handler: (ctx) => traced(decideApproval(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req))) },
  { method: 'POST', re: /^\/api\/agent\/chat$/, handler: (ctx) => handleChat(ctx.user, ctx.body, requestIp(ctx.req)) },
  { method: 'GET', re: /^\/api\/agent\/threads$/, handler: (ctx) => listThreads(ctx.user) },
  { method: 'GET', re: /^\/api\/agent\/threads\/([^/]+)$/, handler: (ctx) => getThread(ctx.user, ctx.params[0]) },
  { method: 'GET', re: /^\/api\/agent\/policy$/, handler: agentPolicy },
  { method: 'GET', re: /^\/api\/users$/, handler: (ctx) => listUsers(ctx.user, { role: ctx.query.get('role'), search: ctx.query.get('search') || '' }) },
  { method: 'POST', re: /^\/api\/users$/, status: 201, handler: (ctx) => createUser(ctx.user, ctx.body, requestIp(ctx.req)) },
  { method: 'PATCH', re: /^\/api\/users\/([^/]+)\/status$/, handler: (ctx) => updateUserStatus(ctx.user, ctx.params[0], ctx.body, requestIp(ctx.req)) },
  { method: 'GET', re: /^\/api\/audit$/, roles: ['admin', 'operator'], handler: (ctx) => listAudit(ctx.user, { limit: Math.min(300, Math.max(1, Number.parseInt(ctx.query.get('limit') || '100', 10) || 100)), action: ctx.query.get('action'), search: ctx.query.get('search') || '' }) },
];

function idempotencyKey(req) {
  const raw = (req.headers.get('idempotency-key') || '').trim();
  if (!raw) return null;
  if (raw.length > 100) throw unauthorized('幂等键过长');
  return raw;
}
function normalizePath(pathname) {
  let target = pathname || '/';
  for (const prefix of ['/.netlify/functions/api', '/.netlify/functions/neighbor-charge']) {
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      target = target.slice(prefix.length) || '/';
      break;
    }
  }
  if (!target.startsWith('/api') && target !== '/' && !target.startsWith('/assets')) target = `/api${target}`;
  return target;
}
function corsHeaders() {
  return {
    'access-control-allow-origin': currentOrigin(),
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, X-Device-Key, X-Trace-Id',
    'access-control-expose-headers': 'X-Trace-Id, X-Response-Time',
    vary: 'Origin',
  };
}
function baseHeaders(extra = {}) {
  return {
    'x-trace-id': traceId(),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-response-time': `${Date.now() - (ALS.getStore()?.started || Date.now())}ms`,
    ...corsHeaders(),
    ...extra,
  };
}
function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: baseHeaders({ 'content-type': 'application/json; charset=utf-8', ...extra }) });
}
function errorResponse(error) {
  const detail = error instanceof ApiError ? error.detail() : { code: 'INTERNAL_ERROR', message: '服务内部错误，请稍后重试', trace_id: traceId() };
  return jsonResponse({ detail }, error instanceof ApiError ? error.status : 500, error instanceof ApiError ? error.headers : {});
}

async function dispatch(req) {
  const url = new URL(req.url, 'https://netlify.local');
  const pathname = normalizePath(url.pathname);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders() });

  let body = {};
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw unprocessable('请求体必须是合法 JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw unprocessable('请求体必须是 JSON 对象');
    }
  }
  const query = url.searchParams;
  let matchedPath = false;
  for (const route of ROUTES) {
    const match = route.re.exec(pathname);
    if (!match) continue;
    matchedPath = true;
    if (route.method !== req.method) continue;
    let user = null;
    if (route.auth === 'device') user = deviceActor(req);
    else if (route.auth !== false) user = currentUser(req);
    if (route.roles && (!user || !route.roles.includes(user.role))) throw forbidden('当前角色无权执行该操作');
    const result = await route.handler({ req, user, body, query, params: match.slice(1), ip: requestIp(req) });
    if (result instanceof Response) return result;
    return jsonResponse(result, route.status || 200);
  }
  if (matchedPath) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方法不被支持');
  throw notFound('接口不存在');
}

export default async function handler(req, context) {
  const trace = req.headers.get('x-trace-id') || crypto.randomBytes(16).toString('hex');
  const origin = req.headers.get('origin') || '*';
  // context 由 Netlify 注入；当前实现无状态，仅保留签名兼容
  void context;
  return ALS.run({ trace, origin, started: Date.now() }, async () => {
    try {
      return await dispatch(req);
    } catch (error) {
      return errorResponse(error);
    }
  });
}

// Routing is declared in netlify.toml (rewrite /api/* -> the function) so the
// SPA fallback can never swallow API requests.
