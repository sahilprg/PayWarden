/* Paywarden owner console.
   Every value from the server is inserted with textContent, never innerHTML: reasons can quote
   text an attacker planted on a product page, and that must stay inert here too. */
(() => {
  'use strict';

  // ── Small helpers ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, value) { try { window[area].setItem(key, value); } catch { /* storage unavailable: keep in memory */ } },
    del(area, key) { try { window[area].removeItem(key); } catch { /* ignore */ } },
  };
  const memory = { token: store.get('sessionStorage', 'pw.token'), name: store.get('localStorage', 'pw.name') };

  const money = (minor, currency = 'USD') =>
    minor === undefined || minor === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
  const time = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
  const short = (id, n = 8) => (id ? String(id).slice(0, n) : '');

  const VERDICT = {
    allow: { cls: 'status-allow', icon: '✓', word: 'Allowed' },
    needs_approval: { cls: 'status-ask', icon: '?', word: 'Sent to you' },
    deny: { cls: 'status-deny', icon: '✕', word: 'Refused' },
  };
  const statusMark = (kind, word, icon) => el('span', { class: `status ${kind}` }, el('span', { class: 'status-icon', 'aria-hidden': 'true', text: icon }), word);
  const verdictMark = (v) => { const m = VERDICT[v] || { cls: 'status-neutral', icon: '•', word: v }; return statusMark(m.cls, m.word, m.icon); };

  let toastTimer;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // ── API ────────────────────────────────────────────────────────────────────
  class Unauthorized extends Error {}
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${memory.token || ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Unauthorized(json.message || 'Owner token rejected.');
    if (!res.ok) throw new Error(json.message || (json.issues && json.issues.map((i) => i.message).join('; ')) || `Request failed (${res.status})`);
    return json;
  }

  async function act(label, fn) {
    try {
      await fn();
      toast(label);
      await refresh();
    } catch (e) {
      if (e instanceof Unauthorized) return showGate(e.message);
      toast(e.message);
    }
  }

  // ── Gate ───────────────────────────────────────────────────────────────────
  function showGate(error) {
    stopPolling();
    $('console').hidden = true;
    $('breaker').hidden = true;
    $('gate').hidden = false;
    $('gate-name').value = memory.name || '';
    const err = $('gate-error');
    err.hidden = !error;
    err.textContent = error || '';
    $('gate-token').focus();
  }
  $('gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    memory.token = $('gate-token').value.trim();
    memory.name = $('gate-name').value.trim();
    store.set('sessionStorage', 'pw.token', memory.token);
    store.set('localStorage', 'pw.name', memory.name);
    $('gate-token').value = '';
    await start();
  });

  // ── Grids ──────────────────────────────────────────────────────────────────
  const theme = agGrid.themeQuartz.withParams({
    fontFamily: 'var(--font)',
    fontSize: 14,
    backgroundColor: 'var(--surface)',
    foregroundColor: 'var(--ink)',
    headerBackgroundColor: 'var(--surface-2)',
    headerTextColor: 'var(--ink-2)',
    borderColor: 'var(--line)',
    rowHoverColor: 'var(--accent-soft)',
    selectedRowBackgroundColor: 'var(--accent-soft)',
    accentColor: 'var(--accent)',
    oddRowBackgroundColor: 'var(--surface)',
    wrapperBorder: false,
    wrapperBorderRadius: 0,
    headerFontWeight: 600,
    spacing: 7,
  });
  const baseGrid = {
    theme,
    rowData: [],
    animateRows: false,
    suppressCellFocus: false,
    domLayout: 'autoHeight',
    pagination: true,
    paginationPageSize: 10,
    paginationPageSizeSelector: [10, 25, 50],
    defaultColDef: { sortable: true, resizable: true, filter: false, minWidth: 90 },
    overlayNoRowsTemplate: '<span style="padding:12px">Nothing yet.</span>',
  };

  const reasonChips = (p) => el('span', {}, (p.value || []).map((r) => el('span', { class: 'code-chip', title: r.message, text: r.code })));

  const decisionsGrid = agGrid.createGrid($('decisions-grid'), {
    ...baseGrid,
    getRowId: (p) => String(p.data.seq),
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    columnDefs: [
      { field: 'ts', headerName: 'When', valueFormatter: (p) => time(p.value), sort: 'desc', minWidth: 150, maxWidth: 170 },
      { field: 'verdict', headerName: 'Outcome', cellRenderer: (p) => verdictMark(p.value), minWidth: 130, maxWidth: 150 },
      { field: 'merchantId', headerName: 'Merchant', minWidth: 170, maxWidth: 200 },
      { field: 'totalMinor', headerName: 'Amount', valueFormatter: (p) => money(p.value), type: 'rightAligned', minWidth: 100, maxWidth: 120 },
      { field: 'reasons', headerName: 'Reasons', cellRenderer: reasonChips, flex: 3, minWidth: 260, sortable: false,
        valueFormatter: (p) => (p.value || []).map((r) => r.code).join(', ') },
    ],
    onSelectionChanged: () => showDecision(decisionsGrid.getSelectedRows()[0]),
  });

  function showDecision(d) {
    const box = $('decision-detail');
    box.replaceChildren();
    if (!d) { box.textContent = 'Select a request to see why it was decided that way.'; return; }
    box.append(
      el('div', {}, verdictMark(d.verdict), ' ', el('span', { text: `${money(d.totalMinor)} at ${d.merchantId || 'unknown merchant'}, ${time(d.ts)}` })),
      d.reasons.length
        ? el('ul', {}, d.reasons.map((r) => el('li', {}, el('span', { class: 'code-chip', text: r.code }), ' ', r.message, ' ', el('span', { style: 'color:var(--muted)', text: `(${r.source === 'ai' ? 'AI check' : r.source === 'catalog' ? 'merchant catalogue' : 'policy rule'})` }))))
        : el('p', { text: 'Every rule passed.' }),
    );
  }

  const ORDER_STATUS = {
    created: ['status-ask', '…', 'Waiting for payer'],
    approved: ['status-ask', '…', 'Payer approved'],
    captured: ['status-allow', '✓', 'Paid'],
    refunded_partial: ['status-neutral', '↺', 'Partly refunded'],
    refunded: ['status-neutral', '↺', 'Refunded'],
  };
  const ordersGrid = agGrid.createGrid($('orders-grid'), {
    ...baseGrid,
    getRowId: (p) => p.data.id,
    columnDefs: [
      { field: 'createdAt', headerName: 'Created', valueFormatter: (p) => time(p.value), sort: 'desc', minWidth: 150, maxWidth: 170 },
      { field: 'paypalOrderId', headerName: 'PayPal order', minWidth: 170, maxWidth: 190, cellClass: 'mono' },
      { headerName: 'Items', valueGetter: (p) => p.data.proposal.items.map((i) => `${i.quantity}× ${i.name}`).join(', '), flex: 1, minWidth: 200,
        tooltipValueGetter: (p) => p.data.proposal.items.map((i) => `${i.quantity}× ${i.name}`).join(', ') },
      { field: 'totalMinor', headerName: 'Total', valueFormatter: (p) => money(p.value, p.data.currency), type: 'rightAligned', minWidth: 90, maxWidth: 110 },
      { field: 'status', headerName: 'Status', minWidth: 160, maxWidth: 180,
        cellRenderer: (p) => { const s = ORDER_STATUS[p.value] || ['status-neutral', '•', p.value]; return statusMark(s[0], s[2], s[1]); } },
      { field: 'refundedMinor', headerName: 'Refunded', valueFormatter: (p) => (p.value ? money(p.value, p.data.currency) : ''), type: 'rightAligned', minWidth: 90, maxWidth: 110 },
      { headerName: 'Next step', minWidth: 200, maxWidth: 230, sortable: false, cellRenderer: (p) => {
          const o = p.data;
          if (o.status !== 'created' && o.status !== 'approved') return '';
          const wrap = el('span', { style: 'display:inline-flex;gap:8px;align-items:center' });
          if (o.approveUrl && /^https:\/\/www\.(sandbox\.)?paypal\.com\//.test(o.approveUrl)) {
            wrap.append(el('a', { href: o.approveUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Pay in PayPal'));
          }
          wrap.append(el('button', { class: 'btn btn-quiet', type: 'button', style: 'min-height:28px',
            onclick: () => act(`Captured ${money(o.totalMinor, o.currency)}.`, () => api('POST', `/v1/orders/${encodeURIComponent(o.id)}/capture`)) }, 'Capture'));
          return wrap;
        } },
    ],
  });

  const auditSummary = (e) => {
    const d = e.data || {};
    const parts = [];
    for (const k of ['orderId', 'approvalId', 'exceptionId', 'mandateId', 'merchantId', 'by', 'approvedBy', 'action', 'code', 'type', 'step']) {
      if (d[k]) parts.push(`${k} ${typeof d[k] === 'string' && d[k].length > 20 ? short(d[k]) : d[k]}`);
    }
    for (const k of ['totalMinor', 'amountMinor', 'refundedMinor']) if (typeof d[k] === 'number') parts.push(money(d[k]));
    if (Array.isArray(d.codes)) parts.push(d.codes.join(', '));
    if (Array.isArray(d.reasons)) parts.push(d.reasons.map((r) => r.code).join(', '));
    return parts.join(', ');
  };
  const auditGrid = agGrid.createGrid($('audit-grid'), {
    ...baseGrid,
    getRowId: (p) => String(p.data.seq),
    columnDefs: [
      { field: 'seq', headerName: '#', sort: 'desc', maxWidth: 80, minWidth: 64, type: 'rightAligned' },
      { field: 'ts', headerName: 'When', valueFormatter: (p) => time(p.value), minWidth: 150, flex: 1 },
      { field: 'type', headerName: 'Event', minWidth: 210, flex: 1.2, cellClass: 'mono' },
      { headerName: 'Details', valueGetter: (p) => auditSummary(p.data), flex: 2.5, minWidth: 240, tooltipValueGetter: (p) => JSON.stringify(p.data.data) },
      { field: 'hash', headerName: 'Hash', valueFormatter: (p) => short(p.value, 12), minWidth: 130, flex: 0.8, cellClass: 'mono' },
    ],
  });

  for (const [tabId, gridId] of [['tab-orders', 'orders-grid'], ['tab-audit', 'audit-grid']]) {
    $(tabId).addEventListener('click', () => {
      for (const [t, g] of [['tab-orders', 'orders-grid'], ['tab-audit', 'audit-grid']]) {
        $(t).setAttribute('aria-selected', String(t === tabId));
        $(g).hidden = g !== gridId;
      }
    });
  }

  // ── Renderers ──────────────────────────────────────────────────────────────
  function renderEnv(data) {
    const env = $('env');
    env.replaceChildren(
      el('span', { class: `env-pill${data.paypal === 'fake' ? ' env-pill-warn' : ''}` }, 'PayPal ', el('b', { text: data.paypal === 'fake' ? 'offline fake' : 'sandbox' })),
      el('span', { class: `env-pill${data.aiProvider.startsWith('heuristic') ? ' env-pill-warn' : ''}` }, 'AI ', el('b', { text: data.aiProvider.split(' (')[0] })),
      el('span', { class: 'env-pill' }, 'Acting as ', el('b', { text: memory.name || 'owner' })),
    );
  }

  function renderBreaker(frozen) {
    $('breaker').hidden = false;
    $('breaker-switch').setAttribute('aria-checked', String(frozen));
    $('breaker-state').textContent = frozen ? 'Agent frozen' : 'Agent can spend';
    $('breaker-hint').textContent = frozen ? 'Every payment and capture is refused. Push up to resume.' : 'Pull down to freeze all agent payments';
  }
  $('breaker-switch').addEventListener('click', () => {
    const frozen = $('breaker-switch').getAttribute('aria-checked') === 'true';
    if (frozen) {
      if (!window.confirm('Resume agent payments? Each one is still checked against its permit.')) return;
      act('Agent payments resumed.', () => api('POST', '/v1/resume', { by: memory.name || 'owner' }));
    } else {
      act('Agent frozen. Every payment and capture is now refused.', () => api('POST', '/v1/kill', { by: memory.name || 'owner', reason: 'Frozen from the owner console' }));
    }
  });

  function renderKpis(data) {
    const c = data.counts;
    const tile = (value, label) => el('div', { class: 'kpi' }, el('div', { class: 'kpi-value', text: value }), el('div', { class: 'kpi-label', text: label }));
    $('kpis').replaceChildren(
      tile(money(c.capturedMinor), 'Paid through PayPal'),
      tile(money(c.refundedMinor), 'Refunded'),
      tile(String(c.allowed), 'Requests allowed'),
      tile(String(c.needsApproval), 'Sent to you'),
      tile(String(c.denied), 'Requests refused'),
    );
  }

  let selectedMandate = null;
  $('permit-select').addEventListener('change', (e) => { selectedMandate = e.target.value; if (lastData) renderPermit(lastData); });

  function renderPermit(data) {
    const box = $('permit');
    const list = data.mandates;
    const picker = $('permit-picker');
    picker.hidden = list.length < 2;
    if (list.length >= 2) {
      const sel = $('permit-select');
      sel.replaceChildren(...list.slice().reverse().map((m) => el('option', { value: m.id, text: `${m.agentId} for ${m.subject} (${m.status}), ${time(m.createdAt)}` })));
      if (!selectedMandate || !list.some((m) => m.id === selectedMandate)) selectedMandate = list[list.length - 1].id;
      sel.value = selectedMandate;
    }
    const m = list.find((x) => x.id === selectedMandate) || list[list.length - 1];
    box.className = 'panel permit';
    box.replaceChildren();
    if (!m) {
      box.append(el('p', { class: 'permit-sub', text: 'No permit yet. Run the demo, or compile and activate a mandate through the API, and it appears here.' }));
      return;
    }
    box.classList.add(`permit-${m.status}`);
    const statusOf = { active: ['status-allow', '✓', 'Active'], revoked: ['status-deny', '✕', 'Revoked'], expired: ['status-deny', '✕', 'Expired'], invalid: ['status-deny', '!', 'Signature invalid'] }[m.status];
    const pct = m.periodLimitMinor ? Math.min(100, (m.spentInPeriodMinor / m.periodLimitMinor) * 100) : 0;
    const tickPct = m.periodLimitMinor ? Math.min(100, (m.perPurchaseLimitMinor / m.periodLimitMinor) * 100) : 0;
    const left = Math.max(0, m.periodLimitMinor - m.spentInPeriodMinor);
    box.append(
      el('div', { class: 'permit-head' },
        el('div', {}, el('div', { class: 'permit-title', text: m.agentId }), el('div', { class: 'permit-sub', text: `Acting for ${m.subject}` })),
        statusMark(statusOf[0], statusOf[2], statusOf[1])),
      el('blockquote', { class: 'permit-task', text: `“${m.task}”` }),
      el('div', { class: 'meter' },
        el('div', { class: 'meter-row' }, el('b', { text: money(m.spentInPeriodMinor, m.currency) }), ` spent of ${money(m.periodLimitMinor, m.currency)} this ${m.periodDays}-day window`),
        el('div', { class: 'meter-track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': m.periodLimitMinor, 'aria-valuenow': m.spentInPeriodMinor, 'aria-label': 'Spent in this period' },
          el('div', { class: 'meter-fill', style: `width:${pct}%` }),
          el('div', { class: 'meter-tick', style: `left:calc(${tickPct}% - 1px)`, title: `Single-purchase limit ${money(m.perPurchaseLimitMinor, m.currency)}` })),
        el('div', { class: 'meter-note', text: `${money(left, m.currency)} left. The tick marks the single-purchase limit of ${money(m.perPurchaseLimitMinor, m.currency)}. Refunds do not give allowance back.` })),
      el('ul', { class: 'permit-rules', 'aria-label': 'Rules, written out by code from the signed values' }, m.summary.map((line) => el('li', { text: line }))),
      el('div', { class: 'permit-foot' },
        el('span', {}, m.signatureValid ? 'Ed25519 signature verified, key ' : 'Signature does NOT verify, key ', el('code', { text: m.keyId })),
        el('span', { class: 'spacer' }),
        m.status === 'active'
          ? el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => {
              if (window.confirm('Revoke this permit? The agent will not be able to spend under it again, and unpaid orders cannot be captured.')) {
                act('Permit revoked.', () => api('POST', `/v1/mandates/${encodeURIComponent(m.id)}/revoke`, { by: memory.name || 'owner' }));
              }
            } }, 'Revoke permit')
          : null),
    );
  }

  function renderInbox(data) {
    const box = $('inbox');
    box.replaceChildren();
    const items = [];
    for (const a of data.pendingApprovals) {
      const p = a.proposal;
      items.push(el('article', { class: 'ticket' },
        el('div', { class: 'ticket-head' }, statusMark('status-ask', 'Payment waiting', '?'), el('h3', { text: p.merchantId }), el('span', { class: 'ticket-amount', text: money(a.decision.totalMinor, p.currency) })),
        el('ul', { class: 'ticket-lines' }, p.items.map((i) => el('li', { text: `${i.quantity}× ${i.name} at ${money(i.unitPriceMinor, p.currency)}` }))),
        el('p', { class: 'ticket-why' }, el('b', { text: 'Why you are being asked: ' }), a.decision.reasons.map((r) => r.message).join(' ')),
        el('div', { class: 'ticket-actions' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => act('Payment approved. It was re-checked against the permit before going to PayPal.', () => api('POST', `/v1/approvals/${a.id}/resolve`, { approver: memory.name || 'owner', approve: true })) }, `Approve ${money(a.decision.totalMinor, p.currency)}`),
          el('button', { class: 'btn', type: 'button', onclick: () => act('Payment rejected.', () => api('POST', `/v1/approvals/${a.id}/resolve`, { approver: memory.name || 'owner', approve: false })) }, 'Reject')),
      ));
    }
    for (const x of data.openExceptions) {
      const r = x.proposedRemedy;
      const order = data.orders.find((o) => o.id === x.orderId);
      const cur = order ? order.currency : 'USD';
      const isRefund = r && (r.action === 'partial_refund' || r.action === 'full_refund') && r.refundAmountMinor;
      items.push(el('article', { class: 'ticket' },
        el('div', { class: 'ticket-head' }, statusMark('status-deny', 'Order arrived wrong', '!'), el('h3', { text: order ? order.merchantId : 'Order' }), el('span', { class: 'ticket-amount', text: isRefund ? money(r.refundAmountMinor, cur) : '' })),
        el('ul', { class: 'ticket-lines' }, x.diffs.map((d) => el('li', { text: `${d.sku}: expected ${d.expectedQty}, shipped ${d.shippedQty}` }))),
        r ? el('p', { class: 'ticket-why' }, el('b', { text: `AI suggests ${r.action.replace(/_/g, ' ')}: ` }), r.rationale || '') : null,
        el('div', { class: 'ticket-actions' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => act(isRefund ? `Refund of ${money(r.refundAmountMinor, cur)} sent through ${data.paypal === 'fake' ? 'the offline PayPal fake' : 'the PayPal sandbox'}.` : 'Remedy approved.', () => api('POST', `/v1/exceptions/${x.id}/approve`, { approvedBy: memory.name || 'owner' })) },
            isRefund ? `Approve refund of ${money(r.refundAmountMinor, cur)}` : 'Approve remedy')),
      ));
    }
    if (!items.length) {
      box.append(el('div', { class: 'inbox-empty' }, el('strong', { text: 'Nothing needs you right now.' }), 'Payments above your approval threshold and orders that arrive wrong will wait here for your decision.'));
      return;
    }
    box.append(el('div', { class: 'inbox' }, items));
  }

  function renderChain(audit) {
    $('chain').replaceChildren(
      audit.ok ? statusMark('status-allow', `Audit chain intact, ${audit.length} entries`, '✓') : statusMark('status-deny', `Audit chain broken at entry ${audit.brokenAt}`, '✕'),
      ' ',
      el('code', { title: audit.head, text: `head ${short(audit.head, 12)}` }),
    );
  }

  // ── Refresh loop ───────────────────────────────────────────────────────────
  let lastData = null;
  let timer = null;
  async function refresh() {
    const data = await api('GET', '/v1/dashboard');
    lastData = data;
    $('gate').hidden = true;
    $('console').hidden = false;
    renderEnv(data);
    renderBreaker(data.killSwitch);
    renderKpis(data);
    renderPermit(data);
    renderInbox(data);
    renderChain(data.audit);
    decisionsGrid.setGridOption('rowData', data.decisions);
    ordersGrid.setGridOption('rowData', data.orders);
    auditGrid.setGridOption('rowData', data.audit.recent);
    const sel = decisionsGrid.getSelectedRows()[0];
    if (sel) showDecision(data.decisions.find((d) => d.seq === sel.seq));
  }
  function stopPolling() { clearInterval(timer); timer = null; }
  function startPolling() {
    stopPolling();
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refresh().catch((e) => { if (e instanceof Unauthorized) showGate(e.message); });
    }, 3000);
  }
  async function start() {
    if (!memory.token || !memory.name) return showGate();
    try {
      await refresh();
      startPolling();
    } catch (e) {
      if (e instanceof Unauthorized) { store.del('sessionStorage', 'pw.token'); memory.token = null; return showGate('That token was not accepted. Use the OWNER_API_TOKEN value, not the agent token.'); }
      showGate(`Could not load the console: ${e.message}`);
    }
  }
  start();
})();
