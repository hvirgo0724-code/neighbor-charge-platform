const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

export function icon(name, size = 18, className = '') {
  return `<svg class="icon ${className}" width="${size}" height="${size}" aria-hidden="true"><use href="#icon-${esc(name)}"></use></svg>`;
}

export function formatMoney(value, digits = 2) {
  const number = Number(value || 0);
  return `¥${number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatNumber(value, digits = 0) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function formatDateTime(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: sameYear ? undefined : 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: options.dateOnly ? undefined : '2-digit',
    minute: options.dateOnly ? undefined : '2-digit',
    hour12: false,
  });
}

export function relativeTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const future = diff < 0;
  const seconds = Math.abs(diff) / 1000;
  let text;
  if (seconds < 60) text = '刚刚';
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)} 分钟`;
  else if (seconds < 86400) text = `${Math.floor(seconds / 3600)} 小时`;
  else if (seconds < 86400 * 30) text = `${Math.floor(seconds / 86400)} 天`;
  else text = formatDateTime(value, { dateOnly: true });
  if (text === '刚刚') return text;
  return future ? `${text}后` : `${text}前`;
}

export function formatPercent(value, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

const STATUS_MAP = {
  available: ['可用', 'ok'],
  charging: ['充电中', 'blue'],
  reserved: ['已预约', 'violet'],
  fault: ['故障', 'danger'],
  offline: ['离线', 'muted'],
  maintenance: ['维护中', 'warn'],
  open: ['待处理', 'warn'],
  assigned: ['已分派', 'blue'],
  processing: ['处理中', 'violet'],
  pending_acceptance: ['待验收', 'warn'],
  closed: ['已关闭', 'muted'],
  completed: ['已完成', 'ok'],
  cancelled: ['已取消', 'muted'],
  refunded: ['已退款', 'danger'],
  pending: ['待审批', 'warn'],
  executed: ['已执行', 'ok'],
  rejected: ['已驳回', 'muted'],
  failed: ['执行失败', 'danger'],
  active: ['正常', 'ok'],
  disabled: ['已停用', 'muted'],
  pending_payment: ['待支付', 'warn'],
  exception: ['异常', 'danger'],
};

const ROLE_MAP = {
  admin: ['管理员', 'violet'],
  operator: ['运营', 'blue'],
  repairer: ['维修', 'warn'],
  finance: ['财务', 'ok'],
  user: ['居民', 'muted'],
};

const LEVEL_MAP = { P1: ['P1 紧急', 'danger'], P2: ['P2 重要', 'warn'], P3: ['P3 一般', 'muted'] };

export function statusBadge(status, kind = '') {
  if (kind === 'role') {
    const [label, tone] = ROLE_MAP[status] || [status, 'muted'];
    return `<span class="badge badge--${tone}">${esc(label)}</span>`;
  }
  if (kind === 'level') {
    const [label, tone] = LEVEL_MAP[status] || [status, 'muted'];
    return `<span class="badge badge--${tone}">${esc(label)}</span>`;
  }
  const [label, tone] = STATUS_MAP[status] || [status || '未知', 'muted'];
  return `<span class="badge badge--${tone}"><i class="badge__dot"></i>${esc(label)}</span>`;
}

export function riskBadge(risk) {
  const map = {
    low: ['低风险', 'ok'],
    medium: ['中风险', 'warn'],
    high: ['高风险', 'danger'],
  };
  const [label, tone] = map[risk] || [risk, 'muted'];
  return `<span class="badge badge--${tone}">${esc(label)}</span>`;
}

export function toast(message, type = 'info', duration = 3200) {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast toast--${type}`;
  item.innerHTML = `<span class="toast__icon">${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info', 16)}</span><span>${esc(message)}</span>`;
  root.appendChild(item);
  requestAnimationFrame(() => item.classList.add('is-visible'));
  window.setTimeout(() => {
    item.classList.remove('is-visible');
    window.setTimeout(() => item.remove(), 220);
  }, duration);
}

export function emptyState(title, description, actionHtml = '', iconName = 'inbox') {
  return `<div class="empty-state">
    <div class="empty-state__icon">${icon(iconName, 26)}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(description)}</p>
    ${actionHtml}
  </div>`;
}

export function skeletonCards(count = 4, className = 'kpi-grid') {
  return `<div class="${className}">${Array.from({ length: count }).map(() => `<div class="skeleton skeleton--card"></div>`).join('')}</div>`;
}

export function progress(value, tone = 'brand') {
  const safe = Math.max(0, Math.min(100, Number(value || 0)));
  return `<div class="progress progress--${tone}" role="progressbar" aria-valuenow="${safe}" aria-valuemin="0" aria-valuemax="100"><span style="width:${safe}%"></span></div>`;
}

export function openModal({ title, subtitle = '', body = '', footer = '', size = 'md', onClose = null }) {
  const root = document.getElementById('modalRoot');
  const wrapper = document.createElement('div');
  wrapper.className = 'overlay';
  wrapper.innerHTML = `<div class="modal modal--${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="modal__head">
      <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
      <button class="icon-btn" data-close aria-label="关闭">${icon('close', 18)}</button>
    </header>
    <div class="modal__body">${body}</div>
    ${footer ? `<footer class="modal__foot">${footer}</footer>` : ''}
  </div>`;
  root.appendChild(wrapper);
  document.body.classList.add('is-locked');
  const close = () => {
    if (!wrapper.isConnected) return;
    wrapper.classList.remove('is-open');
    window.setTimeout(() => {
      wrapper.remove();
      if (!document.querySelector('.overlay')) document.body.classList.remove('is-locked');
    }, 180);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrapper.addEventListener('click', (event) => {
    if (event.target === wrapper || event.target.closest('[data-close]')) close();
  });
  requestAnimationFrame(() => wrapper.classList.add('is-open'));
  const focusTarget = wrapper.querySelector('input, select, textarea, button');
  window.setTimeout(() => focusTarget?.focus(), 60);
  return { close, el: wrapper.querySelector('.modal') };
}

export function confirmDialog({ title = '确认操作', message, confirmText = '确认', cancelText = '取消', danger = false, note = '' }) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      body: `<p class="confirm-text">${esc(message)}</p>${note ? `<div class="notice ${danger ? 'notice--danger' : ''}">${esc(note)}</div>` : ''}`,
      footer: `<button class="btn btn--ghost" data-cancel>${esc(cancelText)}</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm>${esc(confirmText)}</button>`,
      size: 'sm',
      onClose: () => { if (!settled) resolve(false); },
    });
    modal.el.querySelector('[data-cancel]').addEventListener('click', () => { settled = true; modal.close(); resolve(false); });
    modal.el.querySelector('[data-confirm]').addEventListener('click', () => { settled = true; modal.close(); resolve(true); });
  });
}

export function openDrawer({ title, subtitle = '', body = '', footer = '', onClose = null }) {
  const root = document.getElementById('drawerRoot');
  const wrapper = document.createElement('div');
  wrapper.className = 'overlay overlay--drawer';
  wrapper.innerHTML = `<div class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="drawer__head">
      <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
      <button class="icon-btn" data-close aria-label="关闭">${icon('close', 18)}</button>
    </header>
    <div class="drawer__body">${body}</div>
    ${footer ? `<footer class="drawer__foot">${footer}</footer>` : ''}
  </div>`;
  root.appendChild(wrapper);
  document.body.classList.add('is-locked');
  const close = () => {
    if (!wrapper.isConnected) return;
    wrapper.classList.remove('is-open');
    window.setTimeout(() => {
      wrapper.remove();
      if (!document.querySelector('.overlay')) document.body.classList.remove('is-locked');
    }, 180);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrapper.addEventListener('click', (event) => {
    if (event.target === wrapper || event.target.closest('[data-close]')) close();
  });
  requestAnimationFrame(() => wrapper.classList.add('is-open'));
  return { close, el: wrapper.querySelector('.drawer') };
}

export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制到剪贴板', 'success');
  } catch {
    toast('复制失败，请手动选择', 'error');
  }
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

export function drawLineChart(canvas, rows, { key = 'revenue', color = '#0f9d76', fill = 'rgba(15,157,118,.14)', formatter = (value) => value } = {}) {
  const setup = setupCanvas(canvas);
  if (!setup || !rows.length) return;
  const { ctx, width, height } = setup;
  const pad = { top: 18, right: 14, bottom: 28, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = rows.map((row) => Number(row[key] || 0));
  const max = Math.max(...values, 1) * 1.18;
  const min = 0;
  const step = innerW / Math.max(1, rows.length - 1);
  const x = (index) => pad.left + index * step;
  const y = (value) => pad.top + innerH - ((value - min) / (max - min)) * innerH;

  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px "Segoe UI", "PingFang SC", sans-serif';
  ctx.fillStyle = '#8a99aa';
  ctx.strokeStyle = '#e8eef4';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const value = max * (i / 4);
    const lineY = y(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(width - pad.right, lineY);
    ctx.stroke();
    ctx.fillText(formatter(Math.round(value)), 4, lineY + 4);
  }

  const points = values.map((value, index) => [x(index), y(value)]);
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, fill);
  gradient.addColorStop(1, 'rgba(15,157,118,0)');
  ctx.beginPath();
  ctx.moveTo(points[0][0], height - pad.bottom);
  points.forEach(([px, py]) => ctx.lineTo(px, py));
  ctx.lineTo(points[points.length - 1][0], height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach(([px, py], index) => {
    if (index === 0) ctx.moveTo(px, py);
    else {
      const [prevX, prevY] = points[index - 1];
      const midX = (prevX + px) / 2;
      ctx.bezierCurveTo(midX, prevY, midX, py, px, py);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.stroke();

  points.forEach(([px, py], index) => {
    ctx.beginPath();
    ctx.arc(px, py, index === points.length - 1 ? 4 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  });

  ctx.fillStyle = '#8a99aa';
  ctx.textAlign = 'center';
  rows.forEach((row, index) => {
    const label = String(row.date || '').slice(5);
    ctx.fillText(label, x(index), height - 8);
  });
  ctx.textAlign = 'left';
  canvas.dataset.ready = '1';
}

export function drawBarChart(canvas, rows, { key = 'orders', color = '#0f9d76', formatter = (value) => value } = {}) {
  const setup = setupCanvas(canvas);
  if (!setup || !rows.length) return;
  const { ctx, width, height } = setup;
  const pad = { top: 18, right: 12, bottom: 28, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = rows.map((row) => Number(row[key] || 0));
  const max = Math.max(...values, 1) * 1.2;
  const slot = innerW / rows.length;
  const barWidth = Math.min(26, slot * 0.52);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px "Segoe UI", "PingFang SC", sans-serif';
  ctx.strokeStyle = '#e8eef4';
  ctx.fillStyle = '#8a99aa';
  for (let i = 0; i <= 3; i += 1) {
    const value = max * (i / 3);
    const lineY = pad.top + innerH - (value / max) * innerH;
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(width - pad.right, lineY);
    ctx.stroke();
    ctx.fillText(formatter(Math.round(value)), 2, lineY + 4);
  }
  rows.forEach((row, index) => {
    const value = Number(row[key] || 0);
    const barHeight = (value / max) * innerH;
    const px = pad.left + slot * index + (slot - barWidth) / 2;
    const py = pad.top + innerH - barHeight;
    const gradient = ctx.createLinearGradient(0, py, 0, pad.top + innerH);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(15,157,118,.28)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(px, py, barWidth, Math.max(2, barHeight), 6);
    else ctx.rect(px, py, barWidth, Math.max(2, barHeight));
    ctx.fill();
    ctx.fillStyle = '#8a99aa';
    ctx.textAlign = 'center';
    ctx.fillText(String(row.date || '').slice(5), px + barWidth / 2, height - 8);
    ctx.textAlign = 'left';
  });
}

export function drawSparkline(canvas, values, color = '#0f9d76') {
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;
  const numbers = values.map(Number);
  if (!numbers.length) return;
  const max = Math.max(...numbers, 1);
  const min = Math.min(...numbers, 0);
  const step = width / Math.max(1, numbers.length - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  numbers.forEach((value, index) => {
    const px = index * step;
    const py = height - 3 - ((value - min) / Math.max(1, max - min)) * (height - 8);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.stroke();
}

export function parseError(error) {
  if (!error) return '请求失败，请稍后重试';
  if (typeof error === 'string') return error;
  if (error.fields?.length) {
    return error.fields.map((field) => `${field.field || '字段'}：${field.message}`).join('；');
  }
  return error.message || error.detail || '请求失败，请稍后重试';
}

export function debounce(fn, wait = 240) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function escapeAttribute(value) {
  return esc(value).replace(/`/g, '&#96;');
}
