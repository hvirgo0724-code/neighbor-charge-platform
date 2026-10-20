import { api, session, saveSession, clearSession, ApiError } from './api.js';
import * as ui from './ui.js';

const {
  esc, icon, formatMoney, formatNumber, formatDateTime, relativeTime, formatPercent,
  statusBadge, riskBadge, toast, emptyState, skeletonCards, progress, openModal,
  confirmDialog, openDrawer, copyText, drawLineChart, drawBarChart, drawSparkline,
  parseError, debounce,
} = ui;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const AGENT_INTENTS = {
  available_piles: '可用设备查询',
  fault_analysis: '故障归因分析',
  ticket_query: '工单进度查询',
  revenue_analysis: '收入与订单分析',
  metric_explain: '指标解释',
  price_query: '电价查询',
  approval_query: '待审批查询',
  refund_request: '退款申请',
  stop_request: '停机申请',
  price_change_request: '调价申请',
  batch_request: '批量改派申请',
  create_ticket: '创建维修工单',
  help: '能力引导',
};

const AGENT_STATUS = {
  completed: '已完成',
  pending_approval: '待审批',
  needs_clarification: '需要补充',
  denied: '已拦截',
};

function agentIntent(value) {
  return AGENT_INTENTS[value] || value || '—';
}

function agentStatus(value) {
  return AGENT_STATUS[value] || value || '—';
}

const PAGES = [
  { id: 'overview', label: '运营总览', icon: 'grid', section: '运营', roles: ['admin', 'operator', 'repairer', 'finance', 'user'] },
  { id: 'agent', label: 'Agent 工作台', icon: 'bot', section: '运营', roles: ['admin', 'operator', 'repairer', 'finance', 'user'] },
  { id: 'piles', label: '充电设备', icon: 'plug', section: '资产', roles: ['admin', 'operator', 'repairer', 'finance', 'user'] },
  { id: 'orders', label: '订单管理', icon: 'receipt', section: '资产', roles: ['admin', 'operator', 'finance', 'user'] },
  { id: 'events', label: '设备事件', icon: 'activity', section: '资产', roles: ['admin', 'operator', 'repairer'] },
  { id: 'tickets', label: '维修工单', icon: 'tool', section: '协同', roles: ['admin', 'operator', 'repairer', 'user'] },
  { id: 'approvals', label: '审批中心', icon: 'check', section: '协同', roles: ['admin', 'operator', 'finance', 'user'] },
  { id: 'reports', label: '运营报表', icon: 'chart', section: '数据', roles: ['admin', 'operator', 'finance'] },
  { id: 'communities', label: '社区管理', icon: 'building', section: '管理', roles: ['admin', 'operator'] },
  { id: 'users', label: '用户与权限', icon: 'users', section: '管理', roles: ['admin'] },
  { id: 'audit', label: '审计日志', icon: 'shield', section: '管理', roles: ['admin', 'operator'] },
];

const PAGE_TITLES = {
  overview: ['运营中心', '运营总览'],
  agent: ['智能协同', 'Agent 工作台'],
  piles: ['资产运营', '充电设备'],
  orders: ['交易履约', '订单管理'],
  events: ['设备接入', '设备事件'],
  tickets: ['运维闭环', '维修工单'],
  approvals: ['风险控制', '审批中心'],
  reports: ['经营分析', '运营报表'],
  communities: ['组织与资产', '社区管理'],
  users: ['访问控制', '用户与权限'],
  audit: ['安全合规', '审计日志'],
};

const ACTION_LABELS = {
  login: '登录平台', login_failed: '登录失败', logout: '退出登录', create_reservation: '创建预约',
  cancel_reservation: '取消预约', reservation_expired: '预约超时释放', start_charging: '开始充电',
  complete_charging: '完成充电', refund_requested: '申请退款', device_event: '接入设备事件',
  create_ticket: '创建工单', assign_ticket: '分派工单', ticket_assigned: '分派工单', accept_ticket: '维修接单',
  resolve_ticket: '回填维修', create_test_order: '创建测试订单', heartbeat_check: '心跳验收',
  close_ticket: '关闭工单', approval_created: '提交审批', approval_executed: '执行审批',
  approval_rejected: '驳回审批', approval_failed: '审批执行失败', approval_decision: '审批决策',
  create_user: '创建用户', update_user_status: '调整用户状态', create_community: '创建社区',
  create_pile: '新增设备', report_export: '导出报表', agent_chat: 'Agent 咨询',
  order_completed: '完成订单', permission_denied: '权限拒绝',
};

const state = {
  page: 'overview',
  meta: null,
  health: null,
  demoAccounts: { items: [], password: 'admin123' },
  communities: null,
  dashboard: null,
  pileFilters: { status: '', community_id: '', search: '' },
  pileCache: null,
  orderFilters: { status: '', search: '', page: 1 },
  ticketCache: null,
  approvalFilters: { status: '', type: '' },
  reportDays: 7,
  agent: { messages: [], threadId: null, last: null, sending: false },
  auditFilters: { action: '', search: '' },
  renderSeq: 0,
};

let trendChart = null;
let unreadTimer = null;

/* --------------------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------------------ */
async function init() {
  bindLogin();
  bindChrome();
  window.addEventListener('hashchange', () => route());
  window.addEventListener('session:expired', () => {
    toast('登录已失效，请重新登录', 'error');
    clearSession();
    showLogin();
  });
  try {
    const [meta, health, demo] = await Promise.all([api.meta(), api.health().catch(() => null), api.demoAccounts().catch(() => null)]);
    state.meta = meta;
    state.health = health;
    if (demo) state.demoAccounts = demo;
    paintEnvironment();
    renderDemoAccounts();
  } catch (error) {
    const message = parseError(error);
    $('#loginError').textContent = `${message} 请确认后端服务已启动。`;
    $('#demoAccounts').innerHTML = '<span class="muted">无法加载演示账号，请检查 API 服务。</span>';
    $('#loginSubmit').disabled = false;
    paintEnvironment(false);
  }
  if (session.token) {
    try {
      const me = await api.me();
      saveSession(session.token, me.user, session.persistent);
      await enterApp();
      return;
    } catch {
      clearSession();
    }
  }
  showLogin();
}

function bindLogin() {
  const form = $('#loginForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginSubmit');
    const errorBox = $('#loginError');
    errorBox.textContent = '';
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>正在验证';
    try {
      const data = await api.login($('#loginUsername').value.trim(), $('#loginPassword').value);
      saveSession(data.access_token, data.user, $('#remember').checked);
      await enterApp();
    } catch (error) {
      errorBox.textContent = parseError(error);
      button.disabled = false;
      button.textContent = '登录工作台';
    }
  });
  $('#loginPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') form.requestSubmit();
  });
  $('#demoAccounts').addEventListener('click', (event) => {
    const button = event.target.closest('[data-demo-user]');
    if (!button) return;
    $('#loginUsername').value = button.dataset.demoUser;
    $('#loginPassword').value = state.demoAccounts.password || 'admin123';
    form.requestSubmit();
  });
}

function paintEnvironment(healthy = true) {
  const chip = $('#environmentChip');
  if (state.meta?.app) {
    chip.innerHTML = `${icon('bolt', 14)}<span>${state.meta.app.mode === 'demo' ? '演示环境' : '生产环境'}</span><i class="dot ${healthy ? 'dot--live' : 'dot--down'}"></i>`;
  } else {
    chip.innerHTML = `${icon('bolt', 14)}<span>服务未连接</span><i class="dot dot--down"></i>`;
  }
  $('#loginMode').textContent = healthy ? '服务正常' : '服务未连接';
  $('#loginMode').className = `login-mode ${healthy ? 'is-online' : 'is-offline'}`;
}

function renderDemoAccounts() {
  const root = $('#demoAccounts');
  const items = state.demoAccounts.items || [];
  if (!items.length) {
    root.innerHTML = '<span class="muted">演示账号暂不可用</span>';
    return;
  }
  root.innerHTML = items.map((account) => `<button type="button" class="demo-account" data-demo-user="${esc(account.username)}">
    <span class="demo-account__avatar">${esc(account.display_name.slice(0, 1))}</span>
    <span><b>${esc(account.role_label)}</b><small>${esc(account.username)}</small></span>
    ${icon('arrow', 14)}
  </button>`).join('');
  const hint = $('#demoHint');
  if (hint) hint.textContent = `演示密码 ${state.demoAccounts.password || 'admin123'}，点击账号可直接进入`;
}

async function enterApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  document.body.classList.add('is-app');
  updateUserChrome();
  renderNav();
  state.communities = null;
  const allowed = PAGES.filter((page) => can(page.roles));
  const hashPage = location.hash.replace(/^#\/?/, '');
  const target = allowed.find((page) => page.id === hashPage)?.id || allowed[0]?.id || 'overview';
  history.replaceState(null, '', `#/${target}`);
  await renderPage(target);
  refreshBadges();
  if (unreadTimer) window.clearInterval(unreadTimer);
  unreadTimer = window.setInterval(() => {
    if (!document.hidden) refreshBadges();
  }, 60_000);
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  document.body.classList.remove('is-app');
  $('#loginPassword').value = '';
  $('#loginSubmit').disabled = false;
  $('#loginSubmit').textContent = '登录工作台';
  window.setTimeout(() => $('#loginUsername').focus(), 80);
  if (unreadTimer) window.clearInterval(unreadTimer);
}

function currentRole() {
  return session.user?.role || '';
}

function can(roles) {
  return roles.includes(currentRole());
}

function isStaff() {
  return ['admin', 'operator', 'repairer'].includes(currentRole());
}

function canApprove() {
  return ['admin', 'finance'].includes(currentRole());
}

function defaultPage() {
  return PAGES.find((page) => can(page.roles))?.id || 'overview';
}

function updateUserChrome() {
  const user = session.user || {};
  const roleLabels = { admin: '系统管理员', operator: '运营人员', repairer: '维修人员', finance: '财务审批', user: '居民用户' };
  $('#userName').textContent = user.display_name || user.username || '未登录';
  $('#userRole').textContent = roleLabels[user.role] || user.role || '';
  $('#userAvatar').textContent = (user.display_name || user.username || '邻').slice(0, 1);
  $('#userMenuAvatar').textContent = (user.display_name || user.username || '邻').slice(0, 1);
  $('#userMenuRole').textContent = roleLabels[user.role] || user.role || '';
  $('#userMenuName').textContent = user.display_name || user.username || '';
  $('#sidebarMode').textContent = state.meta?.app?.mode === 'demo' ? 'DEMO · 演示数据' : 'PRODUCTION';
  $('#footerMode').textContent = state.meta?.app?.mode === 'demo' ? '演示模式' : '生产模式';
}

function openProfileModal() {
  openModal({
    title: '当前登录账号',
    subtitle: '权限与数据范围由服务端校验',
    size: 'sm',
    body: `<div class="profile-panel">
      <div class="profile-panel__avatar">${esc((session.user?.display_name || '邻').slice(0, 1))}</div>
      <div><h3>${esc(session.user?.display_name || '')}</h3><p>${esc($('#userRole').textContent)} · ${esc(session.user?.tenant_id || '')}</p></div>
    </div>
    <dl class="detail-list">
      <div><dt>登录账号</dt><dd>${esc(session.user?.username || '')}</dd></div>
      <div><dt>授权社区</dt><dd>${esc((session.user?.community_ids || []).join('、') || '全部')}</dd></div>
      <div><dt>联系方式</dt><dd>${esc(session.user?.phone || '—')}</dd></div>
      <div><dt>会话过期</dt><dd>${session.user?.token_exp ? formatDateTime(new Date(session.user.token_exp * 1000)) : '8 小时内'}</dd></div>
    </dl>`,
    footer: '<button class="btn btn--ghost" data-close>关闭</button>',
  });
}

function bindChrome() {  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('is-open');
    $('#scrim').classList.toggle('hidden');
  });
  $('#scrim').addEventListener('click', closeSidebar);
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', () => renderPage(state.page, { force: true }));
  $('#notifyBtn').addEventListener('click', () => {
    if (can(PAGES.find((page) => page.id === 'approvals').roles)) navigate('approvals');
    else toast('当前没有待办审批', 'info');
  });
  $('#userMenuBtn').addEventListener('click', openProfileModal);
  $('#userMenuBtnTop').addEventListener('click', openProfileModal);
  document.addEventListener('click', (event) => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      event.preventDefault();
      navigate(pageButton.dataset.page);
      return;
    }
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      copyText(copyButton.dataset.copy);
    }
  });
}

async function logout() {
  try { await api.logout(); } catch { /* token may already be gone */ }
  clearSession();
  state.agent = { messages: [], threadId: null, last: null, sending: false };
  state.dashboard = null;
  showLogin();
}

function closeSidebar() {
  $('#sidebar').classList.remove('is-open');
  $('#scrim').classList.add('hidden');
}

function navigate(page) {
  if (location.hash === `#/${page}`) {
    renderPage(page);
  } else {
    location.hash = `#/${page}`;
  }
  closeSidebar();
}

function route() {
  if (!session.token) return;
  const page = location.hash.replace(/^#\/?/, '') || defaultPage();
  if (!can(PAGES.find((item) => item.id === page)?.roles || [])) {
    history.replaceState(null, '', `#/${defaultPage()}`);
    renderPage(defaultPage());
    return;
  }
  renderPage(page);
}

function renderNav() {
  const groups = [];
  PAGES.filter((page) => can(page.roles)).forEach((page) => {
    let group = groups.find((item) => item.section === page.section);
    if (!group) {
      group = { section: page.section, pages: [] };
      groups.push(group);
    }
    group.pages.push(page);
  });
  $('#nav').innerHTML = groups.map((group) => `<div class="nav-group">
    <span class="nav-group__label">${esc(group.section)}</span>
    ${group.pages.map((page) => `<button class="nav-item ${state.page === page.id ? 'is-active' : ''}" data-page="${page.id}">
      ${icon(page.icon, 18)}<span>${esc(page.label)}</span>${page.id === 'approvals' ? '<i class="nav-badge hidden" id="approvalBadge">0</i>' : ''}
    </button>`).join('')}
  </div>`).join('');
}

async function refreshBadges() {
  try {
    const data = await api.approvals({ status: 'pending' });
    const count = data.total || 0;
    const badge = $('#approvalBadge');
    if (badge) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.toggle('hidden', count === 0);
    }
    $('#notifyDot').classList.toggle('hidden', count === 0);
    $('#notifyBtn').setAttribute('aria-label', count ? `${count} 条待审批` : '通知');
  } catch { /* badge is non-critical */ }
}

/* --------------------------------------------------------------------------
 * Routing and shell
 * ------------------------------------------------------------------------ */
async function renderPage(page, { force = false } = {}) {
  const definition = PAGES.find((item) => item.id === page);
  if (!definition || !can(definition.roles)) {
    navigate(defaultPage());
    return;
  }
  state.page = page;
  const [eyebrow, title] = PAGE_TITLES[page] || ['运营中心', definition.label];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = page === 'orders' && currentRole() === 'user' ? '我的订单' : title;
  document.title = `${$('#pageTitle').textContent} · 邻里充电运营平台`;
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.page === page));
  const seq = ++state.renderSeq;
  $('#view').innerHTML = pageSkeleton(page);
  try {
    await RENDERERS[page](seq);
  } catch (error) {
    if (seq !== state.renderSeq) return;
    renderPageError(error);
  }
  if (window.innerWidth < 900) closeSidebar();
}

function pageSkeleton(page) {
  if (page === 'agent') {
    return `<div class="agent-layout"><div class="card agent-chat"><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--chat"></div></div><div class="card"><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--line"></div></div></div>`;
  }
  return `<div class="page-intro"><div><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--line"></div></div></div>${skeletonCards(4)}<div class="card"><div class="skeleton skeleton--table"></div></div>`;
}

function renderPageError(error) {
  const trace = error?.traceId ? `<code class="inline-code">${esc(error.traceId)}</code>` : '';
  $('#view').innerHTML = `<div class="page-error card">
    <div class="page-error__icon">${icon('alert', 26)}</div>
    <h2>页面加载失败</h2>
    <p>${esc(parseError(error))}</p>
    ${trace ? `<p class="muted">trace_id：${trace}</p>` : ''}
    <div class="button-row"><button class="btn btn--primary" id="retryPage">${icon('refresh', 16)}重试</button><button class="btn btn--ghost" id="backOverview">返回总览</button></div>
  </div>`;
  $('#retryPage')?.addEventListener('click', () => renderPage(state.page, { force: true }));
  $('#backOverview')?.addEventListener('click', () => navigate('overview'));
}

function pageIntro(title, description, actions = '') {
  return `<div class="page-intro">
    <div><h2>${esc(title)}</h2><p>${esc(description)}</p></div>
    ${actions ? `<div class="page-intro__actions">${actions}</div>` : ''}
  </div>`;
}

function sectionHead(title, description = '', actions = '') {
  return `<div class="section-head"><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div>${actions ? `<div class="section-head__actions">${actions}</div>` : ''}</div>`;
}

function kpiCard({ label, value, sub = '', iconName = 'activity', tone = 'brand', spark = null }) {
  return `<article class="kpi-card kpi-card--${tone}">
    <div class="kpi-card__top"><span>${esc(label)}</span><span class="kpi-card__icon">${icon(iconName, 18)}</span></div>
    <strong class="kpi-card__value">${value}</strong>
    <div class="kpi-card__foot"><span>${sub}</span>${spark ? `<canvas class="sparkline" data-spark="${spark}"></canvas>` : ''}</div>
  </article>`;
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

/* --------------------------------------------------------------------------
 * Overview
 * ------------------------------------------------------------------------ */
async function renderOverview(seq) {
  const data = await api.dashboard();
  if (seq !== state.renderSeq) return;
  state.dashboard = data;
  const k = data.kpis;
  const user = session.user || {};
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const dateText = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
  const personal = data.personal;

  const kpis = personal
    ? [
      kpiCard({ label: '正在充电', value: formatNumber(k.active_sessions), sub: data.active_session ? `${data.active_session.pile_id} · 已充 ${formatNumber(data.active_session.kwh, 1)} 度` : '当前无进行中充电', iconName: 'bolt', tone: 'brand' }),
      kpiCard({ label: '即将开始', value: formatNumber(k.upcoming_reservations), sub: data.next_reservation ? `${formatDateTime(data.next_reservation.reserved_start)} · ${data.next_reservation.pile_id}` : '暂无预约', iconName: 'clock', tone: 'violet' }),
      kpiCard({ label: '累计消费', value: formatMoney(k.my_spend), sub: '已完成订单合计', iconName: 'wallet', tone: 'blue' }),
      kpiCard({ label: '社区可用桩', value: formatNumber(k.available), sub: `共 ${k.piles} 台设备`, iconName: 'plug', tone: 'ok' }),
      kpiCard({ label: '我的申请', value: formatNumber(k.pending_approvals), sub: '待审批结果', iconName: 'check', tone: 'warn' }),
    ]
    : [
      kpiCard({ label: '设备可用率', value: formatPercent(k.availability_rate), sub: `${k.available} / ${k.piles} 台可用`, iconName: 'activity', tone: 'brand', spark: 'availability' }),
      kpiCard({ label: '今日订单', value: formatNumber(k.orders_today), sub: `充电中 ${k.charging} 台`, iconName: 'receipt', tone: 'blue', spark: 'orders' }),
      kpiCard({ label: '今日净收入', value: formatMoney(k.revenue_today), sub: '已扣除退款', iconName: 'wallet', tone: 'ok' }),
      kpiCard({ label: '未关闭工单', value: formatNumber(k.open_tickets), sub: '需要运维闭环', iconName: 'tool', tone: 'warn' }),
      kpiCard({ label: '待审批', value: formatNumber(k.pending_approvals), sub: '高风险动作', iconName: 'shield', tone: 'violet' }),
      kpiCard({ label: '在线设备', value: formatNumber(k.available + k.charging), sub: `故障 ${k.faults} 台`, iconName: 'cpu', tone: 'muted' }),
    ];

  const alerts = data.alerts?.length
    ? data.alerts.map((alert) => `<button class="alert-row" data-alert-type="${esc(alert.type)}" data-alert-target="${esc(alert.target)}">
        <span class="alert-row__level alert-row__level--${alert.level === 'P1' ? 'danger' : alert.level === '审批' ? 'violet' : 'warn'}">${esc(alert.level)}</span>
        <span class="alert-row__body"><b>${esc(alert.title)}</b><small>${esc(alert.detail)}</small></span>
        ${icon('chevron', 16)}
      </button>`).join('')
    : `<div class="empty-inline">${icon('check', 18)}<span>当前没有需要立即处理的告警</span></div>`;

  const communityRows = (data.community_health || []).map((community) => `<button class="health-row" data-community="${esc(community.id)}">
    <span class="health-row__name"><b>${esc(community.name)}</b><small>${esc(community.org_name || '')} · ${community.pile_count} 台设备</small></span>
    <span class="health-row__bar">${progress(community.availability_rate, community.availability_rate >= 80 ? 'brand' : 'warn')}<small>${formatPercent(community.availability_rate)} 可用</small></span>
    <span class="health-row__meta"><b>${community.available_count}</b><small>空闲</small></span>
    <span class="health-row__meta"><b class="${community.open_tickets ? 'text-warn' : ''}">${community.open_tickets}</b><small>工单</small></span>
  </button>`).join('');

  const activity = (data.recent_activity || []).slice(0, 6).map((entry) => `<li class="activity-row">
    <span class="activity-row__dot"></span>
    <div><b>${esc(actionLabel(entry.action))}</b><p>${esc(entry.detail || entry.target_id || '')}</p></div>
    <time>${relativeTime(entry.at)}</time>
  </li>`).join('');

  const activeBanner = personal && (data.active_session || data.next_reservation)
    ? `<div class="live-banner">
        <div class="live-banner__icon">${icon('bolt', 22)}</div>
        <div><span class="eyebrow">${data.active_session ? '正在充电' : '预约提醒'}</span>
          <h3>${data.active_session ? `${esc(data.active_session.pile_code || data.active_session.pile_id)} 充电进行中` : `${esc(data.next_reservation.pile_code || data.next_reservation.pile_id)} 预约即将开始`}</h3>
          <p>${data.active_session ? `已充 ${formatNumber(data.active_session.kwh, 1)} 度，预计费用 ${formatMoney(data.active_session.kwh * data.active_session.price)}` : `${formatDateTime(data.next_reservation.reserved_start)} - ${formatDateTime(data.next_reservation.reserved_end)}`}</p>
        </div>
        <button class="btn btn--light" data-page="orders">查看订单</button>
      </div>`
    : '';

  $('#view').innerHTML = `
    <section class="overview-hero">
      <div>
        <span class="eyebrow">${esc(dateText)}</span>
        <h2>${greeting}，${esc((user.display_name || '伙伴').slice(0, 8))}</h2>
        <p>${personal ? '查看你的充电状态、预约和账单，Agent 随时可以帮你查询。' : `你有 ${formatNumber(k.pending_approvals)} 条待审批、${formatNumber(k.open_tickets)} 张未关闭工单，建议先处理高优先级告警。`}</p>
      </div>
      <div class="overview-hero__actions">
        <button class="btn btn--primary" data-page="agent">${icon('bot', 16)}问问 Agent</button>
        <button class="btn btn--ghost" data-page="${personal ? 'piles' : 'tickets'}">${personal ? '找充电桩' : '处理工单'}</button>
      </div>
    </section>
    ${activeBanner}
    <div class="kpi-grid">${kpis.join('')}</div>
    <div class="overview-grid">
      <article class="card card--chart">
        ${sectionHead(personal ? '我的消费趋势' : '近 7 天收入趋势', '仅统计已完成订单并扣除退款', `<span class="legend"><i></i>净收入</span>`)}
        <div class="chart-wrap"><canvas id="trendChart" class="chart" aria-label="近 7 天趋势"></canvas></div>
      </article>
      <article class="card">
        ${sectionHead('需要关注', '按优先级排序', `<span class="count-pill">${data.alerts?.length || 0}</span>`)}
        <div class="alert-list">${alerts}</div>
      </article>
    </div>
    <div class="overview-grid overview-grid--lower">
      <article class="card">
        ${sectionHead('社区健康度', '可用率与工单压力', `<button class="link-btn" data-page="communities">全部社区 ${icon('arrow', 14)}</button>`)}
        <div class="health-list">${communityRows || ui.emptyState('暂无社区', '还没有授权社区数据')}</div>
      </article>
      <article class="card">
        ${sectionHead('最近动态', '审计留痕', `<button class="link-btn" data-page="${can(['admin', 'operator']) ? 'audit' : 'orders'}">查看全部 ${icon('arrow', 14)}</button>`)}
        <ul class="activity-list">${activity || `<li class="empty-inline">暂无动态</li>`}</ul>
      </article>
    </div>`;

  requestAnimationFrame(() => {
    const canvas = $('#trendChart');
    if (canvas) {
      drawLineChart(canvas, data.trend || [], {
        key: personal ? 'revenue' : 'revenue',
        formatter: (value) => (personal ? `¥${value}` : value >= 1000 ? `${Math.round(value / 1000)}k` : value),
      });
    }
    drawSparklines(data);
    bindOverviewEvents();
  });
}

function drawSparklines(data) {
  const trend = data.trend || [];
  $$('.sparkline').forEach((canvas) => {
    const key = canvas.dataset.spark;
    drawSparkline(canvas, trend.map((row) => row[key === 'availability' ? 'orders' : key] || 0), key === 'availability' ? '#0f9d76' : '#3b82f6');
  });
}

function bindOverviewEvents() {
  $$('[data-alert-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.alertType;
      if (type === 'approval') navigate('approvals');
      else if (type === 'ticket') navigate('tickets');
      else openPileDrawer(button.dataset.alertTarget, renderPage.bind(null, 'overview', { force: true }));
    });
  });
  $$('[data-community]').forEach((button) => {
    button.addEventListener('click', () => {
      state.pileFilters.community_id = button.dataset.community;
      navigate('piles');
    });
  });
}

/* --------------------------------------------------------------------------
 * Agent
 * ------------------------------------------------------------------------ */
function quickPrompts() {
  if (currentRole() === 'user') {
    return ['当前有哪些可用充电桩？', '查看我的订单和消费', '我的报修进度如何？', '申请退款'];
  }
  return [
    '当前有哪些可用充电桩？',
    '分析当前充电桩故障和维修情况',
    '近 7 天运营指标怎么样？',
    '查看待审批申请',
    '为订单 O1005 申请退款 18.6 元',
    '暂停 P003 停机检修 8 小时',
  ];
}

async function renderAgent(seq) {
  if (seq !== state.renderSeq) return;
  paintAgent();
  if (!state.agent.policy) {
    api.agentPolicy().then((policy) => {
      state.agent.policy = policy;
      if (state.page === 'agent') paintAgent();
    }).catch(() => {});
  }
}

function agentMessagesHtml() {
  const messages = state.agent.messages;
  if (!messages.length) {
    return `<div class="agent-welcome">
      <div class="agent-welcome__orb">${icon('bot', 34)}</div>
      <h3>今天想先看哪件事？</h3>
      <p>我会在授权数据范围内查询设备、订单、工单和指标；退款、停机、调价等高风险动作只会生成审批申请。</p>
      <div class="prompt-grid">${quickPrompts().slice(0, 4).map((prompt) => `<button class="prompt-card" data-prompt="${esc(prompt)}">${icon('spark', 16)}<span>${esc(prompt)}</span>${icon('arrow', 14)}</button>`).join('')}</div>
    </div>`;
  }
  return messages.map((message) => {
    if (message.role === 'user') {
      return `<div class="chat-message chat-message--user"><div class="chat-bubble">${esc(message.content).replace(/\n/g, '<br>')}</div><span class="chat-avatar">${esc((session.user?.display_name || '我').slice(0, 1))}</span></div>`;
    }
    if (message.role === 'error') {
      return `<div class="chat-message chat-message--agent"><span class="chat-avatar chat-avatar--bot">${icon('bot', 16)}</span><div class="chat-bubble chat-bubble--error">${esc(message.content)}</div></div>`;
    }
    const data = message.data;
    const approval = data.approval;
    const sources = (data.data_sources || []).map((source) => `<span class="source-chip">${esc(source.name)}${source.count ? ` · ${formatNumber(source.count)}` : ''}</span>`).join('');
    const nodes = (data.nodes || []).map((node) => `<li class="node ${node.status === 'blocked' ? 'node--blocked' : node.status === 'denied' ? 'node--danger' : ''}">
      <span class="node__dot"></span><div><b>${esc(node.node)}</b><small>${esc(node.detail)}</small></div><time>${node.duration_ms}ms</time>
    </li>`).join('');
    return `<div class="chat-message chat-message--agent">
      <span class="chat-avatar chat-avatar--bot">${icon('bot', 16)}</span>
      <div class="chat-bubble chat-bubble--agent">
        <div class="chat-meta">${riskBadge(data.risk)}${statusBadge(data.status === 'completed' ? 'executed' : data.status === 'pending_approval' ? 'pending' : 'open').replace(/已执行|待审批|待处理/, agentStatus(data.status))}<span class="muted">${esc(agentIntent(data.intent))}</span></div>
        <div class="chat-answer">${esc(data.answer).replace(/\n/g, '<br>')}</div>
        ${sources ? `<div class="source-row">${sources}</div>` : ''}
        ${approval ? `<button class="approval-inline" data-page="approvals"><span>${icon('shield', 16)}<b>${esc(approval.id)}</b> 已创建审批</span><span>${esc(approval.impact || '')}${icon('arrow', 14)}</span></button>` : ''}
        ${nodes ? `<details class="trace-details"><summary>${icon('activity', 14)}执行轨迹 ${data.nodes.length} 步 · ${data.duration_ms || 0}ms</summary><ul class="trace-list">${nodes}</ul></details>` : ''}
        <div class="chat-foot"><button class="trace-copy" data-copy="${esc(data.trace_id)}" title="复制 trace_id">${icon('copy', 12)} ${esc((data.trace_id || '').slice(0, 12))}…</button><span>${data.llm_used ? 'LLM 辅助' : '本地工具编排'}</span></div>
      </div>
    </div>`;
  }).join('');
}

function agentSideHtml() {
  const last = state.agent.last;
  const policy = state.agent.policy;
  const tools = policy?.tools || [
    { name: 'query_available_piles', risk: 'low' },
    { name: 'analyze_faults', risk: 'low' },
    { name: 'create_ticket', risk: 'medium' },
    { name: 'request_refund', risk: 'high', mode: 'approval_only' },
  ];
  return `<div class="agent-side-card">
      <div class="agent-side-card__head">${icon('shield', 18)}<h3>执行策略</h3><span class="badge badge--ok">已启用</span></div>
      <p class="muted">高风险动作只进入审批，不会由模型直接执行。所有回答带数据来源与 trace_id。</p>
      <ul class="tool-list">${tools.slice(0, 6).map((tool) => `<li><code>${esc(tool.name)}</code>${riskBadge(tool.risk)}</li>`).join('')}</ul>
    </div>
    <div class="agent-side-card">
      <div class="agent-side-card__head">${icon('activity', 18)}<h3>最近一次调用</h3></div>
      ${last ? `<dl class="detail-list detail-list--compact">
        <div><dt>意图</dt><dd>${esc(agentIntent(last.intent))}</dd></div>
        <div><dt>状态</dt><dd>${esc(agentStatus(last.status))}</dd></div>
        <div><dt>风险</dt><dd>${riskBadge(last.risk)}</dd></div>
        <div><dt>数据来源</dt><dd>${esc((last.data_sources || []).map((item) => item.name).join('、') || '—')}</dd></div>
        <div><dt>trace_id</dt><dd><code class="inline-code">${esc(last.trace_id || '')}</code></dd></div>
      </dl>` : '<p class="muted">还没有调用记录。发送一个问题试试。</p>'}
    </div>
    <div class="agent-side-card agent-side-card--note">
      <div class="agent-side-card__head">${icon('info', 18)}<h3>可以尝试</h3></div>
      <div class="side-prompts">${quickPrompts().slice(2).map((prompt) => `<button data-prompt="${esc(prompt)}">${esc(prompt)}</button>`).join('')}</div>
    </div>`;
}

function paintAgent(rebind = true) {
  $('#view').innerHTML = `<div class="agent-layout">
    <section class="card agent-chat">
      <header class="agent-chat__head">
        <div class="agent-identity"><span class="agent-avatar">${icon('bot', 20)}</span><div><h2>邻里充电 Agent</h2><p><i class="dot dot--live"></i>本地工具编排 · 数据已脱敏</p></div></div>
        <div class="button-row"><button class="icon-btn" id="newChatBtn" title="新对话" aria-label="新对话">${icon('plus', 18)}</button></div>
      </header>
      <div class="chat-scroll" id="chatLog">${agentMessagesHtml()}${state.agent.sending ? `<div class="chat-message chat-message--agent"><span class="chat-avatar chat-avatar--bot">${icon('bot', 16)}</span><div class="chat-bubble typing"><i></i><i></i><i></i></div></div>` : ''}</div>
      <form class="chat-form" id="chatForm">
        <textarea id="agentInput" rows="1" placeholder="描述你要查询的指标、设备或需要发起的审批…" aria-label="发送给 Agent 的消息"></textarea>
        <button class="btn btn--primary" type="submit" ${state.agent.sending ? 'disabled' : ''}>${icon('send', 17)}发送</button>
      </form>
      <div class="quick-bar" id="quickBar">${quickPrompts().map((prompt) => `<button data-prompt="${esc(prompt)}">${esc(prompt)}</button>`).join('')}</div>
    </section>
    <aside class="agent-side">${agentSideHtml()}</aside>
  </div>`;
  if (!rebind) return;
  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendAgent($('#agentInput').value);
  });
  $('#agentInput').addEventListener('input', (event) => {
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  });
  $('#agentInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendAgent(event.target.value);
    }
  });
  $('#newChatBtn').addEventListener('click', () => {
    state.agent = { messages: [], threadId: null, last: null, sending: false };
    paintAgent();
  });
  $$('[data-prompt]').forEach((button) => button.addEventListener('click', () => sendAgent(button.dataset.prompt)));
  const log = $('#chatLog');
  if (log) log.scrollTop = log.scrollHeight;
}

async function sendAgent(text) {
  const message = String(text || '').trim();
  if (!message || state.agent.sending) return;
  state.agent.messages.push({ role: 'user', content: message });
  state.agent.sending = true;
  if (state.page === 'agent') paintAgent();
  try {
    const response = await api.agentChat(message, state.agent.threadId);
    state.agent.threadId = response.thread_id;
    state.agent.last = response;
    state.agent.messages.push({ role: 'agent', data: response });
  } catch (error) {
    state.agent.messages.push({ role: 'error', content: parseError(error) });
  } finally {
    state.agent.sending = false;
    if (state.page === 'agent') paintAgent();
    refreshBadges();
  }
}

/* --------------------------------------------------------------------------
 * Piles
 * ------------------------------------------------------------------------ */
async function loadCommunities(force = false) {
  if (state.communities && !force) return state.communities;
  const data = await api.communities();
  state.communities = data.items || [];
  return state.communities;
}

async function renderPiles(seq) {
  const [piles, communities] = await Promise.all([api.piles(), loadCommunities()]);
  if (seq !== state.renderSeq) return;
  state.pileCache = piles.items || [];
  state.communities = communities;
  const filters = state.pileFilters;
  const actions = can(['admin', 'operator']) ? `<button class="btn btn--primary" id="createPileBtn">${icon('plus', 16)}新增设备</button>` : '';
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>设备资产</h2><p>共 ${piles.total} 台充电桩，实时状态来自设备事件。点击卡片查看遥测与工单。</p></div>
      <div class="page-intro__actions">${isStaff() ? `<button class="btn btn--ghost" data-page="events">${icon('activity', 16)}事件流</button>` : ''}${actions}</div>
    </div>
    <div class="filter-bar card">
      <div class="filter-chips" id="pileStatusChips">
        ${['', 'available', 'charging', 'reserved', 'fault', 'offline'].map((status) => `<button class="chip ${filters.status === status ? 'is-active' : ''}" data-status="${status}">${status ? ({ available: '可用', charging: '充电中', reserved: '已预约', fault: '故障', offline: '离线' }[status]) : '全部'}</button>`).join('')}
      </div>
      <div class="filter-tools">
        <label class="select-wrap">${icon('building', 15)}<select id="pileCommunity">${['<option value="">全部社区</option>', ...communities.map((item) => `<option value="${esc(item.id)}" ${filters.community_id === item.id ? 'selected' : ''}>${esc(item.name)}</option>`)].join('')}</select></label>
        <label class="search-wrap">${icon('search', 16)}<input id="pileSearch" placeholder="搜索编号、型号" value="${esc(filters.search)}"></label>
      </div>
    </div>
    <div id="pileGrid">${pileGridHtml(filterPiles())}</div>`;
  bindPileEvents();
  if (can(['admin', 'operator'])) $('#createPileBtn')?.addEventListener('click', openCreatePileModal);
}

function filterPiles() {
  const { status, community_id, search } = state.pileFilters;
  const keyword = search.trim().toLowerCase();
  return (state.pileCache || []).filter((pile) => {
    if (status && pile.status !== status) return false;
    if (community_id && pile.community_id !== community_id) return false;
    if (keyword && !`${pile.code} ${pile.model} ${pile.community_name}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function pileGridHtml(items) {
  if (!items.length) {
    return emptyState('没有匹配的设备', '调整筛选条件，或检查社区授权范围。', '<button class="btn btn--ghost" id="resetPileFilter">清除筛选</button>', 'plug');
  }
  return `<div class="pile-grid">${items.map((pile) => {
    const tone = pile.status === 'available' ? 'ok' : pile.status === 'fault' ? 'danger' : pile.status === 'charging' ? 'blue' : pile.status === 'offline' ? 'muted' : 'warn';
    return `<article class="pile-card pile-card--${tone}" data-pile-card="${esc(pile.id)}">
      <header class="pile-card__head">
        <div><span class="pile-code">${esc(pile.code)}</span><small>${esc(pile.community_name)} · ${esc(pile.connector)}</small></div>
        ${statusBadge(pile.status)}
      </header>
      <div class="pile-card__power"><strong>${formatNumber(pile.power, 0)}</strong><span>kW</span><i>${icon('bolt', 16)}</i></div>
      <div class="pile-card__meta">
        <span><small>电价</small><b>${formatMoney(pile.price)}/度</b></span>
        <span><small>今日充电</small><b>${formatNumber(pile.today_kwh, 1)} 度</b></span>
        <span><small>累计故障</small><b class="${pile.faults ? 'text-warn' : ''}">${pile.faults} 次</b></span>
      </div>
      <footer class="pile-card__foot">
        <span class="muted">${pile.last_seen_minutes < 999 ? `${formatNumber(pile.last_seen_minutes, 0)} 分钟前心跳` : '暂无心跳'}</span>
        <div class="button-row">
          ${pile.status === 'available' ? `<button class="btn btn--small btn--primary" data-reserve="${esc(pile.id)}">预约</button>` : ''}
          <button class="btn btn--small btn--ghost" data-pile-detail="${esc(pile.id)}">详情</button>
        </div>
      </footer>
    </article>`;
  }).join('')}</div>`;
}

function bindPileEvents() {
  const bindReset = () => {
    $('#resetPileFilter')?.addEventListener('click', () => {
      state.pileFilters = { status: '', community_id: '', search: '' };
      renderPage('piles');
    });
  };
  const refreshGrid = () => {
    $('#pileGrid').innerHTML = pileGridHtml(filterPiles());
    bindPileCardActions();
    bindReset();
  };
  $('#pileStatusChips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-status]');
    if (!chip) return;
    state.pileFilters.status = chip.dataset.status;
    $$('#pileStatusChips .chip').forEach((item) => item.classList.toggle('is-active', item === chip));
    refreshGrid();
  });
  $('#pileCommunity').addEventListener('change', (event) => {
    state.pileFilters.community_id = event.target.value;
    refreshGrid();
  });
  $('#pileSearch').addEventListener('input', debounce((event) => {
    state.pileFilters.search = event.target.value;
    refreshGrid();
  }, 180));
  bindPileCardActions();
  bindReset();
}

function bindPileCardActions() {
  $$('[data-reserve]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const pile = state.pileCache.find((item) => item.id === button.dataset.reserve);
      if (pile) openReservationModal(pile);
    });
  });
  $$('[data-pile-detail]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openPileDrawer(button.dataset.pileDetail);
    });
  });
  $$('[data-pile-card]').forEach((card) => {
    card.addEventListener('click', () => openPileDrawer(card.dataset.pileCard));
  });
}

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openReservationModal(pile) {
  const start = new Date(Date.now() + 30 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const modal = openModal({
    title: `预约 ${pile.code}`,
    subtitle: `${pile.community_name} · ${pile.power}kW · ${formatMoney(pile.price)}/度 · 单次最长 4 小时`,
    body: `<form id="reserveForm" class="form-stack">
      <label class="field"><span>开始时间</span><input type="datetime-local" id="reserveStart" value="${toLocalInput(start)}" required></label>
      <label class="field"><span>结束时间</span><input type="datetime-local" id="reserveEnd" value="${toLocalInput(end)}" required></label>
      <div class="preset-row">${[1, 2, 3].map((hours) => `<button type="button" class="chip" data-duration="${hours}">${hours} 小时</button>`).join('')}</div>
      <label class="field"><span>备注（可选）</span><input id="reserveNote" maxlength="200" placeholder="例如：下班后充电"></label>
      <div class="form-error" id="reserveError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="reserveSubmit">确认预约</button>',
  });
  const refreshEnd = (hours) => {
    const startValue = new Date($('#reserveStart').value);
    if (Number.isNaN(startValue.getTime())) return;
    $('#reserveEnd').value = toLocalInput(new Date(startValue.getTime() + hours * 3600 * 1000));
  };
  modal.el.querySelectorAll('[data-duration]').forEach((button) => {
    button.addEventListener('click', () => refreshEnd(Number(button.dataset.duration)));
  });
  $('#reserveStart').addEventListener('change', () => refreshEnd(2));
  $('#reserveSubmit').addEventListener('click', async () => {
    const error = $('#reserveError');
    error.textContent = '';
    const startsAt = new Date($('#reserveStart').value);
    const endsAt = new Date($('#reserveEnd').value);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      error.textContent = '请选择有效的开始和结束时间。';
      return;
    }
    const hours = (endsAt - startsAt) / 3600000;
    if (hours < 0.5) { error.textContent = '预约时长不能少于 30 分钟。'; return; }
    if (hours > 4) { error.textContent = '单次预约不能超过 4 小时。'; return; }
    const button = $('#reserveSubmit');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>提交中';
    try {
      await api.createReservation({
        pile_id: pile.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        note: $('#reserveNote').value.trim(),
      });
      modal.close();
      toast('预约成功，已锁定该时段', 'success');
      renderPage('piles');
    } catch (err) {
      error.textContent = parseError(err);
      button.disabled = false;
      button.textContent = '确认预约';
    }
  });
}

async function openPileDrawer(id, afterClose = null) {
  const drawer = openDrawer({ title: '设备详情', subtitle: '加载中…', body: '<div class="skeleton skeleton--table"></div>' });
  try {
    const pile = await api.pile(id);
    drawer.close();
    const events = (pile.recent_events || []).map((event) => `<li class="timeline-item"><span class="timeline-dot"></span><div><b>${esc(eventTypeLabel(event.event_type))}</b><p>${esc(JSON.stringify(event.payload || {}))}</p></div><time>${relativeTime(event.occurred_at)}</time></li>`).join('');
    const tickets = (pile.open_tickets || []).map((ticket) => `<button class="list-row" data-open-ticket="${esc(ticket.id)}"><span>${statusBadge(ticket.level, 'level')} ${esc(ticket.title)}</span>${icon('chevron', 14)}</button>`).join('');
    const footer = [];
    if (pile.status === 'available') footer.push(`<button class="btn btn--primary" id="drawerReserve">${icon('calendar', 16)}预约</button>`);
    if (isStaff()) footer.push(`<button class="btn btn--ghost" id="drawerFault">${icon('alert', 16)}模拟事件</button>`);
    footer.push(`<button class="btn btn--ghost" id="drawerTicket">${icon('tool', 16)}提交报修</button>`);
    openDrawer({
      title: `${pile.code} · ${pile.community_name}`,
      subtitle: `${pile.model} · ${pile.connector} · ${pile.power}kW`,
      body: `<div class="drawer-status">${statusBadge(pile.status)}<span class="muted">最后心跳 ${relativeTime(pile.last_seen)}</span></div>
        <dl class="detail-grid">
          <div><dt>电价</dt><dd>${formatMoney(pile.price)}/度</dd></div>
          <div><dt>今日充电</dt><dd>${formatNumber(pile.today_kwh, 1)} 度</dd></div>
          <div><dt>累计充电</dt><dd>${formatNumber(pile.total_kwh, 1)} 度</dd></div>
          <div><dt>累计故障</dt><dd>${pile.faults} 次</dd></div>
          <div><dt>温度</dt><dd>${formatNumber(pile.temperature, 1)} °C</dd></div>
          <div><dt>固件</dt><dd>${esc(pile.firmware || '—')}</dd></div>
          <div><dt>设备编号</dt><dd><code class="inline-code">${esc(pile.id)}</code></dd></div>
          <div><dt>安装时间</dt><dd>${formatDateTime(pile.installed_at, { dateOnly: true })}</dd></div>
        </dl>
        <h4 class="drawer-section-title">最近事件</h4>
        <ul class="timeline">${events || '<li class="empty-inline">暂无事件</li>'}</ul>
        <h4 class="drawer-section-title">未关闭工单</h4>
        <div class="list-stack">${tickets || '<div class="empty-inline">没有未关闭工单</div>'}</div>`,
      footer: footer.join(''),
      onClose: afterClose,
    });
    $('#drawerReserve')?.addEventListener('click', () => openReservationModal(pile));
    $('#drawerFault')?.addEventListener('click', () => openDeviceEventModal(pile));
    $('#drawerTicket')?.addEventListener('click', () => openTicketCreateModal(pile.id));
    $$('[data-open-ticket]').forEach((button) => button.addEventListener('click', () => openTicketDrawer(button.dataset.openTicket)));
  } catch (error) {
    drawer.close();
    toast(parseError(error), 'error');
  }
}

/* --------------------------------------------------------------------------
 * Orders
 * ------------------------------------------------------------------------ */
async function renderOrders(seq) {
  const filters = state.orderFilters;
  const params = { page: filters.page, page_size: 20 };
  if (filters.status) params.status = filters.status;
  if (filters.search) params.search = filters.search;
  const data = await api.orders(params);
  if (seq !== state.renderSeq) return;
  state.orderCache = data;
  const statuses = [
    ['', '全部'], ['reserved', '已预约'], ['charging', '充电中'], ['completed', '已完成'], ['refunded', '已退款'], ['cancelled', '已取消'],
  ];
  const rows = data.items.map((order) => `<tr>
      <td><div class="cell-primary"><b>${esc(order.id)}</b><small>${formatDateTime(order.created_at)}</small></div></td>
      <td>${esc(order.user_name || order.user_id)}</td>
      <td><div class="cell-primary"><b>${esc(order.pile_code || order.pile_id)}</b><small>${esc(order.community_name)}</small></div></td>
      <td>${statusBadge(order.status)}</td>
      <td><div class="cell-primary"><b>${formatMoney(order.amount)}</b><small>${formatNumber(order.kwh, 1)} 度</small></div></td>
      <td><div class="row-actions">${orderActionsHtml(order)}</div></td>
    </tr>`).join('');
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>${currentRole() === 'user' ? '我的充电订单' : '订单与履约'}</h2><p>订单状态变化全部留痕；退款申请进入审批中心，不直接改账。</p></div>
      <div class="page-intro__actions"><span class="count-pill">${data.total} 笔</span></div>
    </div>
    <div class="card">
      <div class="table-toolbar">
        <div class="filter-chips">${statuses.map(([value, label]) => `<button class="chip ${filters.status === value ? 'is-active' : ''}" data-order-status="${value}">${label}</button>`).join('')}</div>
        <label class="search-wrap">${icon('search', 16)}<input id="orderSearch" placeholder="订单号 / 设备编号 / 用户" value="${esc(filters.search)}"></label>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>订单</th><th>用户</th><th>设备 / 社区</th><th>状态</th><th>金额 / 电量</th><th>操作</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">${emptyState('没有订单', '当前筛选条件下没有记录', '', 'receipt')}</td></tr>`}</tbody>
      </table></div>
      <div class="pagination">
        <span>第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 笔</span>
        <div class="button-row"><button class="btn btn--small btn--ghost" id="orderPrev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn btn--small btn--ghost" id="orderNext" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div>
      </div>
    </div>`;
  bindOrderEvents();
}

function orderActionsHtml(order) {
  const actions = order.actions || {};
  const buttons = [];
  if (actions.start) buttons.push(`<button class="btn btn--small btn--primary" data-order-act="start" data-id="${esc(order.id)}">开始充电</button>`);
  if (actions.complete) buttons.push(`<button class="btn btn--small btn--primary" data-order-act="complete" data-id="${esc(order.id)}">完成结算</button>`);
  if (actions.cancel) buttons.push(`<button class="btn btn--small btn--ghost" data-order-act="cancel" data-id="${esc(order.id)}">取消</button>`);
  if (actions.refund) buttons.push(`<button class="btn btn--small btn--ghost" data-order-act="refund" data-id="${esc(order.id)}">申请退款</button>`);
  buttons.push(`<button class="btn btn--small btn--ghost" data-view-order="${esc(order.id)}">详情</button>`);
  return buttons.join('');
}

function bindOrderEvents() {
  $$('[data-order-status]').forEach((button) => button.addEventListener('click', () => {
    state.orderFilters.status = button.dataset.orderStatus;
    state.orderFilters.page = 1;
    renderPage('orders');
  }));
  $('#orderSearch').addEventListener('input', debounce((event) => {
    state.orderFilters.search = event.target.value;
    state.orderFilters.page = 1;
    renderPage('orders');
  }, 320));
  $('#orderPrev')?.addEventListener('click', () => { state.orderFilters.page -= 1; renderPage('orders'); });
  $('#orderNext')?.addEventListener('click', () => { state.orderFilters.page += 1; renderPage('orders'); });
  $$('[data-order-act]').forEach((button) => button.addEventListener('click', () => handleOrderAction(button.dataset.orderAct, button.dataset.id)));
  $$('[data-view-order]').forEach((button) => button.addEventListener('click', () => openOrderDrawer(button.dataset.viewOrder)));
}

async function handleOrderAction(action, id) {
  const order = state.orderCache?.items?.find((item) => item.id === id);
  if (!order) return;
  if (action === 'start') {
    const ok = await confirmDialog({ title: '开始充电', message: `确认在 ${order.pile_code} 开始充电？订单 ${order.id}`, confirmText: '开始充电' });
    if (!ok) return;
    try { await api.startOrder(id); toast('已开始充电', 'success'); renderPage('orders'); } catch (error) { toast(parseError(error), 'error'); }
  }
  if (action === 'complete') {
    const modal = openModal({
      title: '完成充电并结算',
      subtitle: `${order.pile_code} · 电价 ${formatMoney(order.price)}/度`,
      body: `<form id="completeForm" class="form-stack"><label class="field"><span>本次充电量（度）</span><input id="completeKwh" type="number" min="0.1" max="300" step="0.1" value="${Math.max(1, Number(order.kwh) || 4.5)}" required></label><label class="field"><span>备注（可选）</span><input id="completeNote" maxlength="200"></label><div class="form-hint">预计结算金额：<b id="completeAmount">${formatMoney(order.price * (Number(order.kwh) || 4.5))}</b></div></form>`,
      footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="completeSubmit">确认结算</button>',
    });
    const updateAmount = () => { $('#completeAmount').textContent = formatMoney(order.price * (Number($('#completeKwh').value) || 0)); };
    $('#completeKwh').addEventListener('input', updateAmount);
    $('#completeSubmit').addEventListener('click', async () => {
      try {
        await api.completeOrder(id, { kwh: Number($('#completeKwh').value), note: $('#completeNote').value.trim() });
        modal.close();
        toast('订单已完成结算', 'success');
        renderPage('orders');
      } catch (error) { toast(parseError(error), 'error'); }
    });
  }
  if (action === 'cancel') {
    const ok = await confirmDialog({ title: '取消预约', message: `取消订单 ${order.id}？释放的时段将重新开放。`, confirmText: '取消预约', danger: true });
    if (!ok) return;
    try { await api.cancelOrder(id, '用户取消预约'); toast('预约已取消', 'success'); renderPage('orders'); } catch (error) { toast(parseError(error), 'error'); }
  }
  if (action === 'refund') {
    const modal = openModal({
      title: '申请退款',
      subtitle: `订单 ${order.id} · 可退 ${formatMoney(order.remaining_refundable)}`,
      body: `<div class="notice">退款申请会进入审批中心，由管理员或财务审批通过后才会执行。</div>
        <form id="refundForm" class="form-stack">
          <label class="field"><span>退款金额</span><input id="refundAmount" type="number" min="0.01" max="${order.remaining_refundable}" step="0.01" value="${order.remaining_refundable}" required></label>
          <label class="field"><span>退款原因</span><textarea id="refundReason" rows="3" maxlength="500" placeholder="请说明退款原因，便于审批人判断" required></textarea></label>
          <div class="form-error" id="refundError"></div>
        </form>`,
      footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="refundSubmit">提交审批</button>',
    });
    $('#refundSubmit').addEventListener('click', async () => {
      const reason = $('#refundReason').value.trim();
      if (reason.length < 4) { $('#refundError').textContent = '退款原因至少 4 个字。'; return; }
      try {
        await api.requestRefund({ order_id: order.id, amount: Number($('#refundAmount').value), reason });
        modal.close();
        toast('退款审批已创建，等待财务处理', 'success');
        refreshBadges();
        navigate('approvals');
      } catch (error) { $('#refundError').textContent = parseError(error); }
    });
  }
}

async function openOrderDrawer(id) {
  const drawer = openDrawer({ title: '订单详情', subtitle: '加载中…', body: '<div class="skeleton skeleton--table"></div>' });
  try {
    const order = await api.order(id);
    drawer.close();
    openDrawer({
      title: order.id,
      subtitle: `${order.pile_code} · ${order.community_name}`,
      body: `<div class="drawer-status">${statusBadge(order.status)}<span class="muted">${esc(order.user_name || order.user_id)}</span></div>
        <dl class="detail-grid">
          <div><dt>订单金额</dt><dd>${formatMoney(order.amount)}</dd></div>
          <div><dt>充电量</dt><dd>${formatNumber(order.kwh, 1)} 度</dd></div>
          <div><dt>电价</dt><dd>${formatMoney(order.price)}/度</dd></div>
          <div><dt>创建时间</dt><dd>${formatDateTime(order.created_at)}</dd></div>
          <div><dt>预约时段</dt><dd>${formatDateTime(order.reserved_start)} - ${formatDateTime(order.reserved_end)}</dd></div>
          <div><dt>完成时间</dt><dd>${formatDateTime(order.completed_at)}</dd></div>
          <div><dt>退款金额</dt><dd>${formatMoney(order.refund_amount)}</dd></div>
          <div><dt>可退余额</dt><dd>${formatMoney(order.remaining_refundable)}</dd></div>
        </dl>
        ${order.note ? `<div class="notice">${esc(order.note)}</div>` : ''}
        <div class="table-wrap"><table class="data-table data-table--compact"><thead><tr><th>时间</th><th>状态</th><th>操作人</th></tr></thead><tbody>
          <tr><td>${formatDateTime(order.created_at)}</td><td>创建订单</td><td>${esc(order.user_name)}</td></tr>
          ${order.started_at ? `<tr><td>${formatDateTime(order.started_at)}</td><td>开始充电</td><td>${esc(order.user_name)}</td></tr>` : ''}
          ${order.completed_at ? `<tr><td>${formatDateTime(order.completed_at)}</td><td>完成结算</td><td>${esc(order.user_name)}</td></tr>` : ''}
          ${order.refunded_at ? `<tr><td>${formatDateTime(order.refunded_at)}</td><td>退款完成</td><td>财务审批</td></tr>` : ''}
        </tbody></table></div>`,
    });
  } catch (error) { drawer.close(); toast(parseError(error), 'error'); }
}

/* --------------------------------------------------------------------------
 * Tickets
 * ------------------------------------------------------------------------ */
async function renderTickets(seq) {
  const [data, pileData] = await Promise.all([api.tickets(), state.pileCache ? Promise.resolve({ items: state.pileCache }) : api.piles()]);
  if (seq !== state.renderSeq) return;
  state.pileCache = pileData.items || state.pileCache;
  state.ticketCache = data.items || [];
  const groups = [
    { key: 'open', label: '待处理', items: [], tone: 'warn' },
    { key: 'assigned', label: '处理中', items: [], tone: 'blue' },
    { key: 'pending_acceptance', label: '待验收', items: [], tone: 'violet' },
    { key: 'closed', label: '已关闭', items: [], tone: 'muted' },
  ];
  state.ticketCache.forEach((ticket) => {
    const group = ticket.status === 'assigned' || ticket.status === 'processing' ? groups[1] : groups.find((item) => item.key === ticket.status);
    group?.items.push(ticket);
  });
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>${currentRole() === 'user' ? '我的报修' : '维修工单'}</h2><p>工单关闭前必须完成设备心跳与测试订单验收；P1 工单 2 小时内响应。</p></div>
      <div class="page-intro__actions"><button class="btn btn--primary" id="newTicketBtn">${icon('plus', 16)}新建工单</button></div>
    </div>
    <div class="kanban">${groups.map((group) => `<section class="kanban-col kanban-col--${group.tone}">
      <header><h3>${group.label}</h3><span>${group.items.length}</span></header>
      <div class="kanban-list">${group.items.map(ticketCardHtml).join('') || `<div class="kanban-empty">暂无工单</div>`}</div>
    </section>`).join('')}</div>
    <div class="ticket-summary-grid">
      <article class="card">${sectionHead('工单队列健康度', '按当前授权范围统计')}
        <div class="summary-metrics">
          <div><b>${state.ticketCache.filter((item) => item.status !== 'closed').length}</b><span>未关闭</span></div>
          <div><b class="${state.ticketCache.some((item) => item.overdue && item.status !== 'closed') ? 'text-danger' : ''}">${state.ticketCache.filter((item) => item.overdue && item.status !== 'closed').length}</b><span>已超时</span></div>
          <div><b>${state.ticketCache.filter((item) => item.status === 'pending_acceptance').length}</b><span>待验收</span></div>
          <div><b>${formatNumber(state.ticketCache.length ? state.ticketCache.reduce((sum, item) => sum + item.age_minutes, 0) / state.ticketCache.length / 60 : 0, 1)}h</b><span>平均工龄</span></div>
        </div>
      </article>
      <article class="card">${sectionHead('关闭校验', '系统强制执行，不可跳过')}
        <ul class="policy-list">
          <li>${icon('activity', 15)}<div><b>设备心跳</b><small>最后心跳需在 ${state.meta?.limits?.heartbeat_fresh_minutes || 10} 分钟内</small></div><span class="badge badge--ok">强制</span></li>
          <li>${icon('receipt', 15)}<div><b>测试订单</b><small>必须存在一张已完成的测试订单</small></div><span class="badge badge--ok">强制</span></li>
          <li>${icon('tool', 15)}<div><b>维修回填</b><small>处理说明会进入工单时间线</small></div><span class="badge badge--ok">强制</span></li>
        </ul>
      </article>
    </div>`;
  $('#newTicketBtn').addEventListener('click', () => openTicketCreateModal());
  $$('[data-ticket-card]').forEach((card) => card.addEventListener('click', () => openTicketDrawer(card.dataset.ticketCard)));
}

function ticketCardHtml(ticket) {
  const verification = ticket.verification || {};
  return `<button class="ticket-card ${ticket.overdue ? 'is-overdue' : ''}" data-ticket-card="${esc(ticket.id)}">
    <div class="ticket-card__head">${statusBadge(ticket.level, 'level')}<span class="muted">${esc(ticket.id)}</span></div>
    <b class="ticket-card__title">${esc(ticket.title)}</b>
    <p>${esc(ticket.pile_code)} · ${esc(ticket.community_name)}</p>
    <footer>
      <span>${ticket.assignee_name ? esc(ticket.assignee_name) : '未分派'}</span>
      <span class="${ticket.overdue ? 'text-danger' : 'muted'}">${ticket.status === 'closed' ? '已闭环' : ticket.overdue ? '已超时' : `${Math.floor(ticket.age_minutes / 60)}h ${Math.floor(ticket.age_minutes % 60)}m`}</span>
    </footer>
    ${ticket.status === 'pending_acceptance' ? `<div class="ticket-card__checks"><span class="${verification.heartbeat_fresh ? 'ok' : ''}">${icon('activity', 12)}心跳</span><span class="${verification.test_order_id ? 'ok' : ''}">${icon('receipt', 12)}测试单</span></div>` : ''}
  </button>`;
}

async function openTicketDrawer(id) {
  try {
    const ticket = await api.ticket(id);
    const verification = ticket.verification || {};
    const history = (ticket.history || []).map((item) => `<li class="timeline-item"><span class="timeline-dot"></span><div><b>${esc(historyLabel(item.action))}</b><p>${esc(item.note || '')}</p><small>${esc(item.actor_name || item.actor_id || '')}</small></div><time>${relativeTime(item.at)}</time></li>`).join('');
    const checks = `<div class="verification-grid">
      <div class="${verification.heartbeat_fresh ? 'is-ok' : 'is-missing'}"><span>${icon('activity', 16)}设备心跳</span><b>${verification.heartbeat_fresh ? `${formatNumber(verification.heartbeat_age_minutes, 0)} 分钟前` : '已超时'}</b><small>要求 ${verification.policy?.heartbeat_fresh_minutes || 10} 分钟内</small></div>
      <div class="${verification.test_order_id ? 'is-ok' : 'is-missing'}"><span>${icon('receipt', 16)}测试订单</span><b>${verification.test_order_id ? esc(verification.test_order_id) : '未创建'}</b><small>完成后才能验收</small></div>
      <div class="${ticket.resolution ? 'is-ok' : 'is-missing'}"><span>${icon('tool', 16)}维修回填</span><b>${ticket.resolution ? '已填写' : '待补充'}</b><small>需描述处理结果</small></div>
    </div>`;
    const footer = [];
    if (ticket.status === 'open' && can(['admin', 'operator'])) footer.push(`<button class="btn btn--primary" data-ticket-action="assign">${icon('users', 16)}分派</button>`);
    if (ticket.status === 'assigned' && can(['admin', 'repairer'])) footer.push(`<button class="btn btn--primary" data-ticket-action="accept">${icon('check', 16)}接单</button>`);
    if (['assigned', 'processing'].includes(ticket.status) && can(['admin', 'operator', 'repairer'])) footer.push(`<button class="btn btn--primary" data-ticket-action="resolve">${icon('tool', 16)}回填维修</button>`);
    if (ticket.status === 'pending_acceptance' && can(['admin', 'operator', 'repairer'])) {
      footer.push(`<button class="btn btn--ghost" data-ticket-action="heartbeat" title="模拟设备心跳">${icon('activity', 16)}心跳</button>`);
      footer.push(`<button class="btn btn--ghost" data-ticket-action="test-order">${icon('receipt', 16)}测试订单</button>`);
      footer.push(`<button class="btn btn--primary" data-ticket-action="close" ${verification.can_close ? '' : 'disabled'} title="${esc((verification.reasons || []).join('；'))}">${icon('check', 16)}验收关闭</button>`);
    }
    const body = `<div class="drawer-status">${statusBadge(ticket.status)}${statusBadge(ticket.level, 'level')}${ticket.overdue ? '<span class="badge badge--danger">已超时</span>' : ''}<span class="muted">${esc(ticket.id)}</span></div>
      <h3 class="drawer-title">${esc(ticket.title)}</h3>
      <p class="drawer-description">${esc(ticket.description || '')}</p>
      <dl class="detail-grid">
        <div><dt>设备</dt><dd>${esc(ticket.pile_code)}</dd></div>
        <div><dt>社区</dt><dd>${esc(ticket.community_name)}</dd></div>
        <div><dt>负责人</dt><dd>${esc(ticket.assignee_name || '未分派')}</dd></div>
        <div><dt>创建时间</dt><dd>${formatDateTime(ticket.created_at)}</dd></div>
        <div><dt>时限</dt><dd>${formatDateTime(ticket.due_at)}</dd></div>
        <div><dt>来源</dt><dd>${ticket.source === 'device_rule' ? '设备规则' : ticket.source === 'user_report' ? '用户报修' : '人工创建'}</dd></div>
      </dl>
      ${ticket.status === 'pending_acceptance' ? `<h4 class="drawer-section-title">验收检查</h4>${checks}` : ''}
      ${ticket.resolution ? `<div class="notice notice--ok"><b>维修回填：</b>${esc(ticket.resolution)}</div>` : ''}
      <h4 class="drawer-section-title">处理轨迹</h4>
      <ul class="timeline">${history || '<li class="empty-inline">暂无记录</li>'}</ul>
      ${footer.length ? `<div class="drawer-actions">${footer.join('')}</div>` : ''}`;
    const drawer = openDrawer({ title: ticket.id, subtitle: ticket.title, body, size: 'lg' });
    $$('[data-ticket-action]', drawer.el).forEach((button) => button.addEventListener('click', () => handleTicketAction(button.dataset.ticketAction, id, drawer)));
  } catch (error) {
    toast(parseError(error), 'error');
  }
}

function historyLabel(action) {
  return ({ created: '创建工单', assigned: '分派', accepted: '接单', resolved: '回填维修', escalated: '告警升级', test_order: '创建测试订单', closed: '验收关闭', reassigned: '改派' })[action] || action;
}

async function handleTicketAction(action, id, drawer) {
  const ticket = await api.ticket(id).catch(() => null);
  if (!ticket) return;
  if (action === 'assign') {
    const assignees = await api.assignees();
    const modal = openModal({
      title: '分派维修工单',
      subtitle: `${ticket.id} · ${ticket.pile_code}`,
      body: `<div class="list-stack">${assignees.items.map((person) => `<label class="radio-card"><input type="radio" name="assignee" value="${esc(person.id)}"><span><b>${esc(person.display_name)}</b><small>${esc(person.phone || '')} · ${esc(person.community_ids.join('、'))}</small></span></label>`).join('') || '<p class="muted">当前社区没有可用的维修人员。</p>'}</div>`,
      footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="assignSubmit">确认分派</button>',
    });
    $('#assignSubmit').addEventListener('click', async () => {
      const selected = modal.el.querySelector('input[name="assignee"]:checked');
      if (!selected) { toast('请选择维修人员', 'error'); return; }
      try { await api.assignTicket(id, selected.value); modal.close(); drawer.close(); toast('工单已分派', 'success'); renderPage('tickets'); } catch (error) { toast(parseError(error), 'error'); }
    });
  }
  if (action === 'accept') {
    try { await api.acceptTicket(id); drawer.close(); toast('已接单', 'success'); renderPage('tickets'); } catch (error) { toast(parseError(error), 'error'); }
  }
  if (action === 'resolve') {
    const modal = openModal({
      title: '回填维修结果',
      subtitle: `${ticket.id} · ${ticket.title}`,
      body: `<label class="field"><span>处理说明</span><textarea id="resolutionInput" rows="4" maxlength="1000" placeholder="例如：更换锁止机构并完成上电自检。" required></textarea></label><div class="form-error" id="resolveError"></div>`,
      footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="resolveSubmit">提交</button>',
    });
    $('#resolveSubmit').addEventListener('click', async () => {
      const value = $('#resolutionInput').value.trim();
      if (value.length < 5) { $('#resolveError').textContent = '请填写至少 5 个字的处理说明。'; return; }
      try { await api.resolveTicket(id, value); modal.close(); drawer.close(); toast('维修结果已回填，进入待验收', 'success'); renderPage('tickets'); } catch (error) { $('#resolveError').textContent = parseError(error); }
    });
  }
  if (action === 'heartbeat') {
    try { await api.heartbeat(id); toast('已模拟设备心跳', 'success'); drawer.close(); openTicketDrawer(id); } catch (error) { toast(parseError(error), 'error'); }
  }
  if (action === 'test-order') {
    const ok = await confirmDialog({ title: '创建测试订单', message: '将创建一笔 0 元测试订单，用于验证设备可用性。', confirmText: '创建测试单' });
    if (!ok) return;
    try { await api.createTestOrder(id, 0.5); toast('测试订单已完成', 'success'); drawer.close(); openTicketDrawer(id); } catch (error) { toast(parseError(error), 'error'); }
  }
  if (action === 'close') {
    try { await api.closeTicket(id); drawer.close(); toast('验收通过，工单已关闭', 'success'); renderPage('tickets'); } catch (error) { toast(parseError(error), 'error', 5000); }
  }
}

function openTicketCreateModal(pileId = '') {
  const piles = state.pileCache || [];
  const options = piles.map((pile) => `<option value="${esc(pile.id)}" ${pileId === pile.id ? 'selected' : ''}>${esc(pile.code)} · ${esc(pile.community_name)}</option>`).join('');
  const modal = openModal({
    title: '新建维修工单',
    subtitle: '描述现象，运营人员会分派维修人员',
    body: `<form id="ticketForm" class="form-stack">
      <label class="field"><span>设备</span><select id="ticketPile" required>${options || '<option value="">没有可用设备</option>'}</select></label>
      <label class="field"><span>标题</span><input id="ticketTitle" maxlength="120" placeholder="例如：充电枪无法锁止" required></label>
      <label class="field"><span>现象描述</span><textarea id="ticketDescription" rows="3" maxlength="1000" placeholder="补充发生时间、用户反馈、现场情况"></textarea></label>
      ${isStaff() ? `<label class="field"><span>优先级</span><select id="ticketLevel"><option value="P3">P3 一般</option><option value="P2">P2 重要</option><option value="P1">P1 紧急</option></select></label>` : ''}
      <div class="form-error" id="ticketError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="ticketSubmit">提交工单</button>',
  });
  $('#ticketSubmit').addEventListener('click', async () => {
    if (!piles.length) { $('#ticketError').textContent = '暂无可报修设备。'; return; }
    try {
      await api.createTicket({
        pile_id: $('#ticketPile').value,
        title: $('#ticketTitle').value.trim(),
        description: $('#ticketDescription').value.trim(),
        level: isStaff() ? $('#ticketLevel').value : 'P3',
      });
      modal.close();
      toast('工单已创建', 'success');
      renderPage('tickets');
    } catch (error) { $('#ticketError').textContent = parseError(error); }
  });
}

/* --------------------------------------------------------------------------
 * Approvals
 * ------------------------------------------------------------------------ */
async function renderApprovals(seq) {
  const params = {};
  if (state.approvalFilters.status) params.status = state.approvalFilters.status;
  if (state.approvalFilters.type) params.type = state.approvalFilters.type;
  const canCreate = can(['admin', 'operator']);
  const [data, communities, pileData] = await Promise.all([
    api.approvals(params),
    canCreate ? loadCommunities() : Promise.resolve(state.communities || []),
    canCreate && !state.pileCache ? api.piles() : Promise.resolve({ items: state.pileCache || [] }),
  ]);
  if (seq !== state.renderSeq) return;
  state.communities = communities;
  if (canCreate) state.pileCache = pileData.items || state.pileCache;
  state.approvalCache = data.items || [];
  const statuses = [['', '全部'], ['pending', '待审批'], ['executed', '已执行'], ['rejected', '已驳回']];
  const rows = data.items.map((approval) => {
    const actionable = approval.status === 'pending' && canApprove() && approval.requester_id !== session.user?.id;
    return `<div class="approval-card ${approval.status === 'pending' ? 'is-pending' : ''}">
      <div class="approval-card__head">
        <div class="approval-card__title">${icon(approval.type === 'refund' ? 'wallet' : approval.type === 'price_change' ? 'chart' : approval.type === 'stop_pile' ? 'alert' : 'users', 17)}<div><b>${esc(approval.title)}</b><small>${esc(approval.id)} · ${approvalTypeLabel(approval.type)}</small></div></div>
        <div class="approval-card__badges">${riskBadge(approval.risk)}${statusBadge(approval.status)}</div>
      </div>
      <p class="approval-card__impact">${esc(approval.impact)}</p>
      <div class="approval-card__meta"><span>申请人 ${esc(approval.requester_name)}</span><span>${relativeTime(approval.created_at)}</span>${approval.amount ? `<span class="text-warn">${formatMoney(approval.amount)}</span>` : ''}</div>
      <div class="approval-card__actions">
        <button class="btn btn--small btn--ghost" data-approval-detail="${esc(approval.id)}">查看详情</button>
        ${actionable ? `<button class="btn btn--small btn--danger-ghost" data-approval-reject="${esc(approval.id)}">驳回</button><button class="btn btn--small btn--primary" data-approval-approve="${esc(approval.id)}">通过</button>` : ''}
      </div>
    </div>`;
  }).join('');
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>审批中心</h2><p>退款、停机、调价和批量改派必须经过人工审批；申请人与审批人不能为同一人。</p></div>
      <div class="page-intro__actions">${canCreate ? `<button class="btn btn--primary" id="createApprovalBtn">${icon('plus', 16)}发起审批</button>` : ''}<span class="count-pill">${data.items.filter((item) => item.status === 'pending').length} 待处理</span></div>
    </div>
    <div class="filter-bar card"><div class="filter-chips">${statuses.map(([value, label]) => `<button class="chip ${state.approvalFilters.status === value ? 'is-active' : ''}" data-approval-status="${value}">${label}</button>`).join('')}</div>
      <div class="filter-tools"><label class="select-wrap">${icon('filter', 15)}<select id="approvalType"><option value="">全部类型</option><option value="refund" ${state.approvalFilters.type === 'refund' ? 'selected' : ''}>退款</option><option value="stop_pile" ${state.approvalFilters.type === 'stop_pile' ? 'selected' : ''}>停机</option><option value="price_change" ${state.approvalFilters.type === 'price_change' ? 'selected' : ''}>调价</option><option value="batch_reassign" ${state.approvalFilters.type === 'batch_reassign' ? 'selected' : ''}>批量改派</option></select></label></div>
    </div>
    <div class="approval-grid">${rows || emptyState('暂无审批', '当前筛选条件下没有记录', '', 'check')}</div>
    <div class="approval-bottom-grid">
      <article class="card">${sectionHead('审批执行回执', '通过后立即执行，禁止重复决策')}
        <ul class="receipt-list">${data.items.filter((item) => item.status !== 'pending').slice(0, 4).map((item) => `<li><span class="badge ${item.status === 'executed' ? 'badge--ok' : item.status === 'rejected' ? 'badge--muted' : 'badge--danger'}">${item.status === 'executed' ? '已执行' : item.status === 'rejected' ? '已驳回' : '失败'}</span><div><b>${esc(item.id)} · ${esc(item.title)}</b><small>${esc(item.execution_result || item.decision_comment || item.impact)}</small></div><time>${relativeTime(item.decided_at || item.created_at)}</time></li>`).join('') || '<li class="empty-inline">暂无已处理审批</li>'}</ul>
      </article>
      <article class="card">${sectionHead('风险门规则', '服务端强制执行')}
        <ul class="isolation-list">
          <li>${icon('shield', 16)}<div><b>只有审批不执行</b><small>Agent 和申请接口都不会直接改资金或设备状态</small></div></li>
          <li>${icon('users', 16)}<div><b>申请与审批分离</b><small>申请人不能审批自己的申请</small></div></li>
          <li>${icon('check', 16)}<div><b>一次性执行</b><small>审批状态变化后不可重复决策或重复执行</small></div></li>
          <li>${icon('activity', 16)}<div><b>回执留痕</b><small>执行结果写入审计日志并以 trace_id 关联</small></div></li>
        </ul>
      </article>
    </div>`;
  if (canCreate) $('#createApprovalBtn').addEventListener('click', openCreateApprovalModal);
  $$('[data-approval-status]').forEach((button) => button.addEventListener('click', () => { state.approvalFilters.status = button.dataset.approvalStatus; renderPage('approvals'); }));
  $('#approvalType').addEventListener('change', (event) => { state.approvalFilters.type = event.target.value; renderPage('approvals'); });
  $$('[data-approval-detail]').forEach((button) => button.addEventListener('click', () => openApprovalDrawer(button.dataset.approvalDetail)));
  $$('[data-approval-approve]').forEach((button) => button.addEventListener('click', () => decideApproval(button.dataset.approvalApprove, true)));
  $$('[data-approval-reject]').forEach((button) => button.addEventListener('click', () => decideApproval(button.dataset.approvalReject, false)));
}

function approvalTypeLabel(type) {
  return ({ refund: '退款', stop_pile: '停机', price_change: '调价', batch_reassign: '批量改派' })[type] || type;
}

async function decideApproval(id, approved) {
  const approval = state.approvalCache?.find((item) => item.id === id);
  const modal = openModal({
    title: approved ? '通过审批' : '驳回审批',
    subtitle: approval ? `${approval.id} · ${approval.title}` : id,
    body: `${approval ? `<div class="notice ${approved ? '' : 'notice--danger'}">${esc(approval.impact)}</div>` : ''}
      <label class="field"><span>审批意见${approved ? '（可选）' : ''}</span><textarea id="decisionComment" rows="3" maxlength="500" placeholder="${approved ? '确认执行影响范围与金额' : '请说明驳回原因'}"></textarea></label>
      <div class="form-error" id="decisionError"></div>`,
    footer: `<button class="btn btn--ghost" data-close>取消</button><button class="btn ${approved ? 'btn--primary' : 'btn--danger'}" id="decisionSubmit">${approved ? '确认通过并执行' : '确认驳回'}</button>`,
  });
  $('#decisionSubmit').addEventListener('click', async () => {
    const comment = $('#decisionComment').value.trim();
    if (!approved && comment.length < 2) { $('#decisionError').textContent = '驳回时必须填写审批意见。'; return; }
    try {
      await api.decideApproval(id, approved, comment);
      modal.close();
      toast(approved ? '审批已通过并执行' : '审批已驳回', 'success');
      renderPage('approvals');
      refreshBadges();
    } catch (error) { $('#decisionError').textContent = parseError(error); }
  });
}

async function openApprovalDrawer(id) {
  const drawer = openDrawer({ title: '审批详情', subtitle: '加载中…', body: '<div class="skeleton skeleton--table"></div>' });
  try {
    const approval = await api.approval(id);
    drawer.close();
    const actionable = approval.status === 'pending' && canApprove() && approval.requester_id !== session.user?.id;
    openDrawer({
      title: approval.id,
      subtitle: approval.title,
      body: `<div class="drawer-status">${statusBadge(approval.status)}${riskBadge(approval.risk)}<span class="muted">${approvalTypeLabel(approval.type)}</span></div>
        <div class="notice"><b>影响范围：</b>${esc(approval.impact)}</div>
        <p class="drawer-description">${esc(approval.reason)}</p>
        <dl class="detail-grid">
          <div><dt>金额</dt><dd>${formatMoney(approval.amount)}</dd></div>
          <div><dt>申请人</dt><dd>${esc(approval.requester_name)}</dd></div>
          <div><dt>申请时间</dt><dd>${formatDateTime(approval.created_at)}</dd></div>
          <div><dt>审批人</dt><dd>${approval.decided_by ? esc(approval.decided_by) : '—'}</dd></div>
          <div><dt>审批时间</dt><dd>${formatDateTime(approval.decided_at)}</dd></div>
          <div><dt>执行时间</dt><dd>${formatDateTime(approval.executed_at)}</dd></div>
        </dl>
        <h4 class="drawer-section-title">风险因素</h4>
        <ul class="risk-list">${(approval.risk_factors || []).map((factor) => `<li>${icon('alert', 14)}${esc(factor)}</li>`).join('')}</ul>
        ${approval.decision_comment ? `<div class="notice"><b>审批意见：</b>${esc(approval.decision_comment)}</div>` : ''}
        ${approval.execution_result ? `<div class="notice notice--ok"><b>执行回执：</b>${esc(approval.execution_result)}</div>` : ''}
        <h4 class="drawer-section-title">申请数据</h4>
        <pre class="code-block">${esc(JSON.stringify(approval.payload, null, 2))}</pre>`,
      footer: actionable ? `<button class="btn btn--danger-ghost" data-drawer-reject>驳回</button><button class="btn btn--primary" data-drawer-approve>通过并执行</button>` : '<button class="btn btn--ghost" data-close>关闭</button>',
    });
    $$('[data-drawer-approve]').forEach((button) => button.addEventListener('click', () => decideApproval(id, true)));
    $$('[data-drawer-reject]').forEach((button) => button.addEventListener('click', () => decideApproval(id, false)));
  } catch (error) { drawer.close(); toast(parseError(error), 'error'); }
}

function openCreateApprovalModal() {
  const communities = state.communities || [];
  const piles = state.pileCache || [];
  const modal = openModal({
    title: '发起审批申请',
    subtitle: '高风险动作需另一位管理员或财务审批',
    body: `<form id="approvalForm" class="form-stack">
      <label class="field"><span>类型</span><select id="approvalCreateType"><option value="stop_pile">停机检修</option><option value="price_change">电价调整</option></select></label>
      <div id="approvalFields"></div>
      <label class="field"><span>申请理由</span><textarea id="approvalReason" rows="3" maxlength="500" placeholder="说明业务原因与影响范围" required></textarea></label>
      <div class="form-error" id="approvalCreateError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="approvalCreateSubmit">提交审批</button>',
  });
  const paintFields = () => {
    const type = $('#approvalCreateType').value;
    $('#approvalFields').innerHTML = type === 'stop_pile'
      ? `<label class="field"><span>设备</span><select id="approvalPile">${piles.map((pile) => `<option value="${esc(pile.id)}">${esc(pile.code)} · ${esc(pile.community_name)}</option>`).join('')}</select></label><label class="field"><span>停机时长（小时）</span><input id="approvalHours" type="number" min="1" max="48" value="8"></label>`
      : `<label class="field"><span>社区</span><select id="approvalCommunity">${communities.map((community) => `<option value="${esc(community.id)}">${esc(community.name)}</option>`).join('')}</select></label><label class="field"><span>新电价（元/度）</span><input id="approvalPrice" type="number" min="0.2" max="5" step="0.01" value="1.5"></label>`;
  };
  paintFields();
  $('#approvalCreateType').addEventListener('change', paintFields);
  $('#approvalCreateSubmit').addEventListener('click', async () => {
    const type = $('#approvalCreateType').value;
    const reason = $('#approvalReason').value.trim();
    if (reason.length < 4) { $('#approvalCreateError').textContent = '申请理由至少 4 个字。'; return; }
    const payload = type === 'stop_pile'
      ? { pile_id: $('#approvalPile').value, duration_hours: Number($('#approvalHours').value) }
      : { community_id: $('#approvalCommunity').value, new_price: Number($('#approvalPrice').value) };
    try {
      await api.createApproval({ type, reason, payload, amount: 0 });
      modal.close();
      toast('审批申请已创建', 'success');
      renderPage('approvals');
      refreshBadges();
    } catch (error) { $('#approvalCreateError').textContent = parseError(error); }
  });
}

/* --------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------ */
async function renderReports(seq) {
  const data = await api.report(state.reportDays);
  if (seq !== state.renderSeq) return;
  const k = data.kpis;
  const totalTickets = Object.values(data.ticket_levels || {}).reduce((sum, value) => sum + value, 0) || 1;
  const donut = `conic-gradient(#e05d5d 0 ${(data.ticket_levels.P1 / totalTickets) * 100}%, #e8a23a ${(data.ticket_levels.P1 / totalTickets) * 100}% ${((data.ticket_levels.P1 + data.ticket_levels.P2) / totalTickets) * 100}%, #7c8ea3 ${((data.ticket_levels.P1 + data.ticket_levels.P2) / totalTickets) * 100}% 100%)`;
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>运营报表</h2><p>按完成时间统计，测试订单不计入收入；退款按净额扣减。</p></div>
      <div class="page-intro__actions"><div class="segmented">${[7, 30].map((days) => `<button class="${state.reportDays === days ? 'is-active' : ''}" data-report-days="${days}">近 ${days} 天</button>`).join('')}</div><button class="btn btn--ghost" id="exportReport">${icon('download', 16)}导出 CSV</button></div>
    </div>
    <div class="kpi-grid">
      ${kpiCard({ label: '净收入', value: formatMoney(k.revenue), sub: `退款 ${formatMoney(k.refund_amount)}`, iconName: 'wallet', tone: 'ok' })}
      ${kpiCard({ label: '完成订单', value: formatNumber(k.orders), sub: `客单价 ${formatMoney(k.avg_order_amount)}`, iconName: 'receipt', tone: 'blue' })}
      ${kpiCard({ label: '设备可用率', value: formatPercent(k.availability_rate), sub: `${k.total_piles} 台在网设备`, iconName: 'activity', tone: 'brand' })}
      ${kpiCard({ label: '设备利用率', value: formatPercent(k.utilization), sub: `充电量 ${formatNumber(k.kwh, 0)} 度`, iconName: 'bolt', tone: 'violet' })}
      ${kpiCard({ label: '平均修复时长', value: `${formatNumber(k.mttr_hours, 1)}h`, sub: `预约成功率 ${formatPercent(k.reservation_success_rate)}`, iconName: 'tool', tone: 'warn' })}
      ${kpiCard({ label: '未闭环', value: formatNumber(k.open_tickets), sub: `待审批 ${k.pending_approvals}`, iconName: 'shield', tone: 'danger' })}
    </div>
    <div class="report-grid">
      <article class="card card--chart">${sectionHead('收入与订单趋势', data.period.label, '<span class="legend"><i></i>净收入</span>')}<div class="chart-wrap chart-wrap--tall"><canvas id="reportRevenue" class="chart"></canvas></div></article>
      <article class="card">${sectionHead('工单等级分布', '当前未关闭')}<div class="donut-wrap"><div class="donut" style="background:${donut}"><span>${totalTickets}</span><small>未关闭</small></div><ul class="donut-legend"><li><i class="bg-danger"></i>P1 紧急 <b>${data.ticket_levels.P1}</b></li><li><i class="bg-warn"></i>P2 重要 <b>${data.ticket_levels.P2}</b></li><li><i class="bg-muted"></i>P3 一般 <b>${data.ticket_levels.P3}</b></li></ul></div></article>
    </div>
    <div class="report-grid report-grid--even">
      <article class="card card--chart">${sectionHead('订单量走势', '按完成日期')}<div class="chart-wrap"><canvas id="reportOrders" class="chart"></canvas></div></article>
      <article class="card">${sectionHead('高故障设备', '累计故障次数')}<div class="fault-list">${(data.top_faults || []).map((pile) => `<button class="fault-row" data-fault-pile="${esc(pile.id)}"><span><b>${esc(pile.code)}</b><small>${esc(pile.community_name)}</small></span><span class="fault-row__bar">${progress(Math.min(100, pile.faults * 20), 'danger')}</span><b class="text-danger">${pile.faults} 次</b></button>`).join('') || '<div class="empty-inline">暂无故障记录</div>'}</div></article>
    </div>
    <article class="card">
      ${sectionHead('社区经营对比', '按净收入排序')}
      <div class="table-wrap"><table class="data-table"><thead><tr><th>社区</th><th>设备</th><th>可用率</th><th>利用率</th><th>订单</th><th>收入</th><th>未关闭工单</th></tr></thead><tbody>
        ${(data.communities || []).map((row) => `<tr><td><b>${esc(row.name)}</b></td><td>${row.piles}</td><td>${formatPercent(row.availability_rate)}</td><td><div class="cell-bar">${progress(row.utilization, 'brand')}<span>${formatPercent(row.utilization)}</span></div></td><td>${row.orders}</td><td><b>${formatMoney(row.revenue)}</b></td><td class="${row.open_tickets ? 'text-warn' : ''}">${row.open_tickets}</td></tr>`).join('')}
      </tbody></table></div>
    </article>`;
  requestAnimationFrame(() => {
    drawLineChart($('#reportRevenue'), data.trend || [], { key: 'revenue', formatter: (value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value });
    drawBarChart($('#reportOrders'), data.trend || [], { key: 'orders', color: '#3b82f6' });
  });
  $$('[data-report-days]').forEach((button) => button.addEventListener('click', () => { state.reportDays = Number(button.dataset.reportDays); renderPage('reports'); }));
  $('#exportReport').addEventListener('click', async () => {
    try { await api.downloadReport(state.reportDays); toast('报表已导出', 'success'); } catch (error) { toast(parseError(error), 'error'); }
  });
  $$('[data-fault-pile]').forEach((button) => button.addEventListener('click', () => openPileDrawer(button.dataset.faultPile)));
}

/* --------------------------------------------------------------------------
 * Communities and users
 * ------------------------------------------------------------------------ */
async function renderCommunities(seq) {
  const communities = await loadCommunities(true);
  if (seq !== state.renderSeq) return;
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>社区与组织</h2><p>运营人员只能访问被授权社区；社区之间设备、订单和工单数据相互隔离。</p></div>
      <div class="page-intro__actions">${can(['admin']) ? `<button class="btn btn--primary" id="createCommunityBtn">${icon('plus', 16)}新增社区</button>` : ''}</div>
    </div>
    <div class="community-grid">${communities.map((community) => `<article class="community-card">
      <header><div class="community-card__icon">${icon('building', 20)}</div><div><h3>${esc(community.name)}</h3><p>${esc(community.org_name)}</p></div>${statusBadge(community.fault_count ? 'fault' : 'active')}</header>
      <p class="community-card__address">${icon('pin', 14)}${esc(community.address)}</p>
      <div class="community-card__stats">
        <span><b>${community.pile_count}</b><small>设备</small></span>
        <span><b>${formatPercent(community.availability_rate)}</b><small>可用率</small></span>
        <span><b>${community.open_tickets}</b><small>工单</small></span>
        <span><b>${formatNumber(community.total_power, 0)}</b><small>kW</small></span>
      </div>
      ${progress(community.availability_rate, community.availability_rate >= 80 ? 'brand' : 'warn')}
      <footer><span>${esc(community.contact || '—')} · ${esc(community.phone || '')}</span><button class="link-btn" data-community-piles="${esc(community.id)}">设备清单 ${icon('arrow', 14)}</button></footer>
    </article>`).join('')}</div>
    <div class="community-bottom-grid">
      <article class="card">${sectionHead('社区资源分布', '按设备实时状态拆解')}
        <div class="resource-list">${communities.map((community) => {
          const total = Math.max(1, community.pile_count);
          const available = community.available_count / total * 100;
          const charging = community.charging_count / total * 100;
          return `<div class="resource-row"><span><b>${esc(community.name)}</b><small>${community.pile_count} 台设备</small></span><div class="stacked-bar"><i class="bg-ok" style="width:${available}%"></i><i class="bg-blue" style="width:${charging}%"></i><i class="bg-danger" style="width:${100 - available - charging}%"></i></div><span class="muted">${community.available_count} 空闲</span></div>`;
        }).join('')}</div>
        <div class="legend-row"><span><i class="bg-ok"></i>可用</span><span><i class="bg-blue"></i>充电中</span><span><i class="bg-danger"></i>异常/维护</span></div>
      </article>
      <article class="card">${sectionHead('数据隔离边界', '后端强制执行')}
        <ul class="isolation-list">
          <li>${icon('shield', 16)}<div><b>租户隔离</b><small>每次查询先校验 tenant_id，跨租户直接 403</small></div></li>
          <li>${icon('users', 16)}<div><b>社区范围</b><small>运营/维修仅能访问已授权社区</small></div></li>
          <li>${icon('receipt', 16)}<div><b>本人数据</b><small>居民用户只能读取本人订单与申请</small></div></li>
          <li>${icon('activity', 16)}<div><b>审计留痕</b><small>越权尝试写入 permission_denied 日志</small></div></li>
        </ul>
      </article>
    </div>`;
  if (can(['admin'])) $('#createCommunityBtn').addEventListener('click', openCreateCommunityModal);
  $$('[data-community-piles]').forEach((button) => button.addEventListener('click', () => {
    state.pileFilters.community_id = button.dataset.communityPiles;
    navigate('piles');
  }));
}

function openCreateCommunityModal() {
  const modal = openModal({
    title: '新增社区',
    body: `<form id="communityForm" class="form-stack">
      <label class="field"><span>社区名称</span><input id="communityName" maxlength="60" placeholder="例如：梧桐里社区" required></label>
      <label class="field"><span>详细地址</span><input id="communityAddress" maxlength="160" placeholder="城市 / 区 / 街道" required></label>
      <div class="form-row"><label class="field"><span>城市</span><input id="communityCity" value="北京市" maxlength="40"></label><label class="field"><span>区县</span><input id="communityDistrict" maxlength="40" placeholder="朝阳区"></label></div>
      <div class="form-row"><label class="field"><span>联系人</span><input id="communityContact" maxlength="40"></label><label class="field"><span>联系电话</span><input id="communityPhone" maxlength="20"></label></div>
      <div class="form-error" id="communityError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="communitySubmit">创建社区</button>',
  });
  $('#communitySubmit').addEventListener('click', async () => {
    try {
      await api.createCommunity({
        name: $('#communityName').value.trim(), address: $('#communityAddress').value.trim(),
        city: $('#communityCity').value.trim(), district: $('#communityDistrict').value.trim(),
        contact: $('#communityContact').value.trim(), phone: $('#communityPhone').value.trim(),
      });
      modal.close();
      toast('社区已创建', 'success');
      renderPage('communities');
    } catch (error) { $('#communityError').textContent = parseError(error); }
  });
}

async function renderUsers(seq) {
  const [data, communities] = await Promise.all([api.users(), loadCommunities()]);
  if (seq !== state.renderSeq) return;
  state.communities = communities;
  const communityName = (id) => communities.find((item) => item.id === id)?.name || id;
  $('#view').innerHTML = `
    <div class="page-intro">
      <div><h2>用户与权限</h2><p>角色决定菜单与接口权限；社区授权进一步限定可见数据。前端菜单隐藏不能替代后端鉴权。</p></div>
      <div class="page-intro__actions"><button class="btn btn--primary" id="createUserBtn">${icon('plus', 16)}新增用户</button></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="data-table">
      <thead><tr><th>用户</th><th>账号</th><th>角色</th><th>授权社区</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
      <tbody>${data.items.map((user) => `<tr>
        <td><div class="user-cell"><span class="mini-avatar">${esc(user.display_name.slice(0, 1))}</span><div><b>${esc(user.display_name)}</b><small>${esc(user.phone || user.email || '')}</small></div></div></td>
        <td><code class="inline-code">${esc(user.username)}</code></td>
        <td>${statusBadge(user.role, 'role')}</td>
        <td class="muted">${esc(user.community_ids.map(communityName).join('、') || '全部')}</td>
        <td>${statusBadge(user.status)}</td>
        <td>${user.last_login_at ? relativeTime(user.last_login_at) : '从未登录'}</td>
        <td><button class="btn btn--small btn--ghost" data-toggle-user="${esc(user.id)}" data-status="${user.status}" ${user.id === session.user?.id ? 'disabled' : ''}>${user.status === 'active' ? '停用' : '启用'}</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
  $('#createUserBtn').addEventListener('click', () => openCreateUserModal(communities));
  $$('[data-toggle-user]').forEach((button) => button.addEventListener('click', async () => {
    const next = button.dataset.status === 'active' ? 'disabled' : 'active';
    const ok = await confirmDialog({ title: next === 'disabled' ? '停用账号' : '启用账号', message: `确认${next === 'disabled' ? '停用' : '启用'}该账号？`, confirmText: next === 'disabled' ? '停用' : '启用', danger: next === 'disabled' });
    if (!ok) return;
    try { await api.setUserStatus(button.dataset.toggleUser, next); toast('账号状态已更新', 'success'); renderPage('users'); } catch (error) { toast(parseError(error), 'error'); }
  }));
}

function openCreateUserModal(communities) {
  const modal = openModal({
    title: '新增用户',
    subtitle: '密码至少 6 位，演示环境建议使用统一演示密码',
    body: `<form id="userForm" class="form-stack">
      <div class="form-row"><label class="field"><span>账号</span><input id="newUsername" maxlength="40" placeholder="字母开头" required></label><label class="field"><span>姓名</span><input id="newDisplayName" maxlength="40" required></label></div>
      <div class="form-row"><label class="field"><span>角色</span><select id="newRole">${['operator', 'repairer', 'finance', 'user'].map((role) => `<option value="${role}">${{ operator: '运营人员', repairer: '维修人员', finance: '财务审批', user: '居民用户' }[role]}</option>`).join('')}</select></label><label class="field"><span>初始密码</span><input id="newPassword" type="password" minlength="6" value="admin123" required></label></div>
      <label class="field"><span>授权社区</span><div class="checkbox-grid">${communities.map((community) => `<label class="check"><input type="checkbox" value="${esc(community.id)}" name="userCommunity"><span>${esc(community.name)}</span></label>`).join('')}</div></label>
      <div class="form-row"><label class="field"><span>手机号</span><input id="newPhone" maxlength="20"></label><label class="field"><span>邮箱</span><input id="newEmail" maxlength="120" type="email"></label></div>
      <div class="form-error" id="userError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="userSubmit">创建用户</button>',
  });
  $('#userSubmit').addEventListener('click', async () => {
    const communityIds = $$('input[name="userCommunity"]:checked', modal.el).map((input) => input.value);
    try {
      await api.createUser({
        username: $('#newUsername').value.trim(), display_name: $('#newDisplayName').value.trim(),
        password: $('#newPassword').value, role: $('#newRole').value, community_ids: communityIds,
        phone: $('#newPhone').value.trim(), email: $('#newEmail').value.trim(),
      });
      modal.close();
      toast('用户已创建', 'success');
      renderPage('users');
    } catch (error) { $('#userError').textContent = parseError(error); }
  });
}

/* --------------------------------------------------------------------------
 * Audit and events
 * ------------------------------------------------------------------------ */
async function renderAudit(seq) {
  const params = { limit: 200 };
  if (state.auditFilters.action) params.action = state.auditFilters.action;
  if (state.auditFilters.search) params.search = state.auditFilters.search;
  const data = await api.audit(params);
  if (seq !== state.renderSeq) return;
  const actions = Array.from(new Set((data.items || []).map((item) => item.action))).sort();
  $('#view').innerHTML = `
    <div class="page-intro"><div><h2>审计日志</h2><p>登录、权限拒绝、设备事件、订单状态、工单、审批和 Agent 调用均留痕。</p></div><span class="count-pill">${data.items.length} 条</span></div>
    <div class="filter-bar card"><div class="filter-tools"><label class="select-wrap">${icon('filter', 15)}<select id="auditAction"><option value="">全部动作</option>${actions.map((action) => `<option value="${esc(action)}" ${state.auditFilters.action === action ? 'selected' : ''}>${esc(actionLabel(action))}</option>`).join('')}</select></label><label class="search-wrap">${icon('search', 16)}<input id="auditSearch" placeholder="搜索操作人、对象或详情" value="${esc(state.auditFilters.search)}"></label></div></div>
    <div class="card"><div class="table-wrap"><table class="data-table data-table--audit"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>trace_id</th></tr></thead><tbody>
      ${data.items.map((entry) => `<tr>
        <td><div class="cell-primary"><b>${formatDateTime(entry.at)}</b><small>${relativeTime(entry.at)}</small></div></td>
        <td><div class="cell-primary"><b>${esc(entry.actor_name)}</b><small>${esc(entry.actor_role)}</small></div></td>
        <td><span class="badge badge--muted">${esc(actionLabel(entry.action))}</span></td>
        <td><div class="cell-primary"><b>${esc(entry.target_id || '—')}</b><small>${esc(entry.target_type || '')}</small></div></td>
        <td class="audit-detail" title="${esc(entry.detail)}">${esc(entry.detail)}</td>
        <td><button class="trace-copy" data-copy="${esc(entry.trace_id)}">${icon('copy', 12)}${esc((entry.trace_id || '').slice(0, 10))}…</button></td>
      </tr>`).join('') || `<tr><td colspan="6">${emptyState('暂无审计记录', '当前筛选条件下没有日志', '', 'shield')}</td></tr>`}
    </tbody></table></div></div>`;
  $('#auditAction').addEventListener('change', (event) => { state.auditFilters.action = event.target.value; renderPage('audit'); });
  $('#auditSearch').addEventListener('input', debounce((event) => { state.auditFilters.search = event.target.value; renderPage('audit'); }, 320));
}

function eventTypeLabel(type) {
  return ({ heartbeat: '心跳', power: '功率', current: '电流', temperature: '温度', offline: '离线', fault: '故障', charge_interrupted: '充电中断', restored: '恢复' })[type] || type;
}

async function renderEvents(seq) {
  const [data, piles] = await Promise.all([api.events(120), state.pileCache ? Promise.resolve({ items: state.pileCache }) : api.piles()]);
  if (seq !== state.renderSeq) return;
  state.pileCache = piles.items || state.pileCache;
  $('#view').innerHTML = `
    <div class="page-intro"><div><h2>设备事件</h2><p>事件按 event_id 幂等去重；故障、离线、温度过高会自动生成或升级工单。</p></div><div class="page-intro__actions">${isStaff() ? `<button class="btn btn--primary" id="ingestEventBtn">${icon('plus', 16)}接入事件</button>` : ''}</div></div>
    <div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>设备</th><th>事件</th><th>Payload</th><th>处理结果</th><th>trace_id</th></tr></thead><tbody>
      ${(data.items || []).map((event) => `<tr>
        <td><div class="cell-primary"><b>${formatDateTime(event.occurred_at)}</b><small>${relativeTime(event.occurred_at)}</small></div></td>
        <td><code class="inline-code">${esc(event.pile_id)}</code></td>
        <td><span class="badge badge--${event.event_type === 'fault' || event.event_type === 'offline' ? 'danger' : event.event_type === 'heartbeat' ? 'ok' : 'blue'}">${esc(eventTypeLabel(event.event_type))}</span></td>
        <td><code class="payload-code">${esc(JSON.stringify(event.payload || {}))}</code></td>
        <td>${event.ticket_id ? `<button class="link-btn" data-event-ticket="${esc(event.ticket_id)}">生成 ${esc(event.ticket_id)}</button>` : '<span class="muted">已记录</span>'}</td>
        <td><button class="trace-copy" data-copy="${esc(event.trace_id)}">${icon('copy', 12)}${esc((event.trace_id || '').slice(0, 10))}…</button></td>
      </tr>`).join('') || `<tr><td colspan="6">${emptyState('暂无事件', '设备网关还没有上报事件', '', 'activity')}</td></tr>`}
    </tbody></table></div></div>`;
  $('#ingestEventBtn')?.addEventListener('click', () => openDeviceEventModal());
  $$('[data-event-ticket]').forEach((button) => button.addEventListener('click', () => openTicketDrawer(button.dataset.eventTicket)));
}

function openDeviceEventModal(pile = null) {
  const piles = state.pileCache || [];
  const modal = openModal({
    title: pile ? `模拟事件 · ${pile.code}` : '接入设备事件',
    subtitle: '用于演示设备网关上报，事件会立即进入状态机与工单规则',
    body: `<form id="eventForm" class="form-stack">
      <label class="field"><span>设备</span><select id="eventPile">${piles.map((item) => `<option value="${esc(item.id)}" ${pile?.id === item.id ? 'selected' : ''}>${esc(item.code)} · ${esc(item.community_name)}</option>`).join('')}</select></label>
      <label class="field"><span>事件类型</span><select id="eventType"><option value="fault">故障 fault</option><option value="offline">离线 offline</option><option value="charge_interrupted">充电中断</option><option value="temperature">温度上报</option><option value="heartbeat">心跳</option><option value="restored">恢复</option></select></label>
      <label class="field"><span>Payload（JSON）</span><textarea id="eventPayload" rows="3" class="mono-input">{"code":"E-107","temperature":72}</textarea></label>
      <div class="form-error" id="eventError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="eventSubmit">提交事件</button>',
  });
  $('#eventSubmit').addEventListener('click', async () => {
    let payload;
    try { payload = JSON.parse($('#eventPayload').value || '{}'); } catch { $('#eventError').textContent = 'Payload 必须是合法 JSON。'; return; }
    try {
      await api.ingestEvent({
        event_id: `EVT-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        pile_id: $('#eventPile').value,
        event_type: $('#eventType').value,
        payload,
      });
      modal.close();
      toast('事件已接入，规则引擎已处理', 'success');
      renderPage(state.page === 'piles' ? 'piles' : 'events');
    } catch (error) { $('#eventError').textContent = parseError(error); }
  });
}

function openCreatePileModal() {
  const communities = state.communities || [];
  const modal = openModal({
    title: '新增充电桩',
    body: `<form id="pileForm" class="form-stack">
      <label class="field"><span>所属社区</span><select id="newPileCommunity">${communities.map((community) => `<option value="${esc(community.id)}">${esc(community.name)}</option>`).join('')}</select></label>
      <div class="form-row"><label class="field"><span>设备编号</span><input id="newPileCode" maxlength="50" placeholder="例如：C 区-01" required></label><label class="field"><span>额定功率（kW）</span><input id="newPilePower" type="number" min="1" max="480" value="7" required></label></div>
      <div class="form-row"><label class="field"><span>型号</span><input id="newPileModel" value="邻里 AC7" maxlength="60"></label><label class="field"><span>接口</span><select id="newPileConnector"><option>国标交流</option><option>国标直流</option></select></label></div>
      <label class="field"><span>电价（元/度）</span><input id="newPilePrice" type="number" min="0.2" max="10" step="0.01" value="1.2" required></label>
      <div class="form-error" id="pileError"></div>
    </form>`,
    footer: '<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" id="pileSubmit">新增设备</button>',
  });
  $('#pileSubmit').addEventListener('click', async () => {
    try {
      await api.createPile({
        community_id: $('#newPileCommunity').value, code: $('#newPileCode').value.trim(),
        power: Number($('#newPilePower').value), model: $('#newPileModel').value.trim(),
        connector: $('#newPileConnector').value, price: Number($('#newPilePrice').value),
      });
      modal.close();
      toast('设备已新增', 'success');
      renderPage('piles');
    } catch (error) { $('#pileError').textContent = parseError(error); }
  });
}

/* --------------------------------------------------------------------------
 * Renderer registry
 * ------------------------------------------------------------------------ */
const RENDERERS = {
  overview: renderOverview,
  agent: renderAgent,
  piles: renderPiles,
  orders: renderOrders,
  events: renderEvents,
  tickets: renderTickets,
  approvals: renderApprovals,
  reports: renderReports,
  communities: renderCommunities,
  users: renderUsers,
  audit: renderAudit,
};

init();
