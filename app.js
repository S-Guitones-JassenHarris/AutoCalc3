// ================================================================
// MVP with CSV-driven Machines and Job Types/Fields
// - Machines auto-load from: data/machines_demo.csv (optional)
// - Job Types & Fields auto-load from: data/job_fields_demo.csv (optional)
// - Falls back to placeholders if CSVs are missing
// - No external libraries
// ================================================================

// ---- Storage key (version it when schema changes) ----
const STORAGE_VERSION = 'v5';
const STORAGE_KEY = `batch_calc_mvp_${STORAGE_VERSION}`;

// Allow demo mode without persistence: add ?nopersist to URL
const NO_PERSIST = new URLSearchParams(location.search).has('nopersist');

// ---- Machines (mutable; overridden by CSV if present) ----
let MACHINES = [{ id: 'mA', name: 'Machine A' }];

// ---- Job Types (mutable; overridden by CSV if present) ----
// Shape after load: [{ id, name, fields:[{key,label,type,min,step,default}], compute(item) {..} }]
let JOB_TYPES = [
  {
    id: 'jobA',
    name: 'Job A',
    fields: [
      { key: 'units', label: 'Units', type: 'number', min: 0, step: 1, default: 1 },
      { key: 'costA', label: 'Cost A (per unit)', type: 'number', min: 0, step: 0.01, default: 0 },
    ],
    compute(item) {
      const units = num(item.values.units, 0);
      const costA = num(item.values.costA, 0);
      return round(units * costA);
    },
  },
];

// ---- State ----
const state = loadState() || {
  quotations: [newQuotation('Quote 1')],
  activeId: null,
  taxPct: 0, // keep as-is; easy to remove later
};
if (!state.activeId) state.activeId = state.quotations[0].id;

// ================================================================
// CSV loaders
// ================================================================

// Machines: expects machine_id,machine_name
async function loadDemoMachines() {
  try {
    const txt = await fetch('data/machines_demo.csv', { cache: 'no-store' }).then(guardOk).then((r) => r.text());
    const rows = parseCSV(txt);
    const normalized = rows
      .map((r) => ({
        id: String(r.machine_id || r.machineId || r.id || '').trim(),
        name: String(r.machine_name || r.machineName || r.name || '').trim(),
      }))
      .filter((m) => m.id && m.name);
    if (normalized.length) MACHINES = normalized;
  } catch (e) {
    console.log('[machines] demo not loaded:', e?.message || e);
  }
}

// Job fields: one row per field; grouped into job types
// Required columns: job_type_id, job_type_name, key, label
// Optional: type (text|number), min, step, default
async function loadDemoJobTypes() {
  try {
    const txt = await fetch('data/job_fields_demo.csv', { cache: 'no-store' }).then(guardOk).then((r) => r.text());
    const rows = parseCSV(txt).filter(
      (r) => (r.job_type_id || '').trim() && (r.key || '').trim() && (r.label || '').trim()
    );
    if (!rows.length) return;

    // Group by job_type_id
    const byType = new Map();
    for (const r of rows) {
      const id = String(r.job_type_id).trim();
      const name = String(r.job_type_name || id).trim();
      const field = normalizeField(r);
      if (!byType.has(id)) byType.set(id, { id, name, fields: [] });
      byType.get(id).fields.push(field);
    }

    // Build JOB_TYPES array with a safe default compute
    const built = Array.from(byType.values())
      .map((jt) => ({
        ...jt,
        compute: makeDefaultCompute(jt.fields),
      }))
      .filter((jt) => jt.fields.length);

    if (built.length) JOB_TYPES = built;

    // Repair existing quotes if their jobType disappeared
    for (const q of state.quotations) {
      if (!JOB_TYPES.find((j) => j.id === q.jobTypeId)) {
        q.jobTypeId = JOB_TYPES[0].id;
        q.items.forEach((it) => (it.values = defaultValuesFor(jobTypeById(q.jobTypeId))));
      }
    }
  } catch (e) {
    console.log('[job types] demo not loaded:', e?.message || e);
  }
}

function normalizeField(r) {
  const type = (String(r.type || 'text').toLowerCase()).trim();
  const parsed = {
    key: String(r.key).trim(),
    label: String(r.label).trim(),
    type: type === 'number' ? 'number' : 'text',
  };
  if (parsed.type === 'number') {
    if (r.min !== undefined && r.min !== '') parsed.min = asNum(r.min, undefined);
    if (r.step !== undefined && r.step !== '') parsed.step = asNum(r.step, undefined);
    if (r.default !== undefined && r.default !== '') parsed.default = asNum(r.default, 0);
    else parsed.default = 0;
  } else {
    if (r.default !== undefined) parsed.default = String(r.default);
  }
  return parsed;
}

// Default compute fallback
function makeDefaultCompute(fields) {
  const hasUnits = fields.some((f) => f.key.toLowerCase() === 'units');
  const costKeys = fields
    .filter((f) => f.type === 'number' && /(cost|rate)/i.test(f.key))
    .map((f) => f.key);

  if (hasUnits && costKeys.length) {
    return (item) => {
      const units = num(item.values['units'], 0);
      const per = costKeys.reduce((acc, k) => acc + num(item.values[k], 0), 0);
      return round(units * per);
    };
  }
  const numericKeys = fields.filter((f) => f.type === 'number').map((f) => f.key);
  return (item) => round(numericKeys.reduce((acc, k) => acc + num(item.values[k], 0), 0));
}

// ================================================================
// App model & utils
// ================================================================
function newId(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}
function newQuotation(name) {
  return { id: newId('q'), name, jobTypeId: JOB_TYPES[0].id, items: [] };
}
function defaultValuesFor(jobType) {
  const jt = jobType && Array.isArray(jobType.fields) ? jobType : { fields: [] };
  const v = {};
  jt.fields.forEach((f) => (v[f.key] = f.default ?? (f.type === 'number' ? 0 : '')));
  return v;
}
function newItemForQuote(q) {
  const jt = jobTypeById(q?.jobTypeId);
  const m = MACHINES?.[0] || { id: 'mA' };
  return {
    id: newId('it'),
    machineId: m.id,
    values: defaultValuesFor(jt),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round(n) {
  return Math.round(n * 100) / 100;
}

function save() {
  if (NO_PERSIST) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadState() {
  if (NO_PERSIST) return null;
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function jobTypeById(id) {
  return JOB_TYPES.find((j) => j.id === id) || JOB_TYPES[0];
}
function machineById(id) {
  return MACHINES.find((m) => m.id === id) || MACHINES[0];
}

function guardOk(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// Simple CSV parser (header row + comma separated)
function parseCSV(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',').map((s) => s.trim());
  return lines
    .map((line) => {
      const vals = line.split(',');
      const obj = {};
      cols.forEach((c, i) => (obj[c] = (vals[i] || '').trim()));
      return obj;
    })
    .filter((obj) => Object.values(obj).some((v) => v !== ''));
}

// ================================================================
// Rendering
// ================================================================
const barsEl = document.getElementById('bars');
function renderBars() {
  barsEl.innerHTML = '';

  const sum = computeSummaryTotals();
  const summary = document.createElement('div');
  summary.className = 'bar summary';
  summary.innerHTML = `
    <div class="name">Summary (All Quotations)</div>
    <div class="tot">Grand Total: <strong>₱ ${sum.grandTotal.toLocaleString()}</strong></div>
    <div class="status muted">Quotes: ${state.quotations.length}</div>
  `;
  barsEl.appendChild(summary);

  state.quotations.forEach((q) => {
    const t = computeQuotationTotals(q);
    const jt = jobTypeById(q.jobTypeId);
    const bar = document.createElement('div');
    bar.className = 'bar' + (q.id === state.activeId ? ' active' : '');
    bar.innerHTML = `
      <div class="name">${q.name}</div>
      <div class="status muted">Job Type: ${jt?.name || '(none)'}</div>
      <div class="tot">Subtotal: ₱ ${t.subtotal.toLocaleString()}</div>
      <div class="tot">Tax: ₱ ${t.tax.toLocaleString()}</div>
      <div class="tot"><strong>Grand: ₱ ${t.grand.toLocaleString()}</strong></div>
      <div class="status">Items: ${Array.isArray(q.items) ? q.items.length : 0}</div>
    `;
    bar.addEventListener('click', () => {
      state.activeId = q.id;
      save();
      renderSafe();
    });
    barsEl.appendChild(bar);
  });

  const add = document.createElement('button');
  add.className = 'bar newBtn';
  add.textContent = '+ New quotation';
  add.addEventListener('click', () => {
    const q = newQuotation('Quote ' + (state.quotations.length + 1));
    state.quotations.push(q);
    state.activeId = q.id;
    save();
    renderSafe();
  });
  barsEl.appendChild(add);
}

const editorEl = document.getElementById('editor');
function renderEditor() {
  const q = state.quotations.find((x) => x.id === state.activeId);
  if (!q) {
    editorEl.innerHTML = '<em>No active quotation.</em>';
    return;
  }
  const qTotals = computeQuotationTotals(q);
  const jt = jobTypeById(q.jobTypeId);

  const header = document.createElement('div');
  header.className = 'controls';

  const nameInp = document.createElement('input');
  nameInp.value = q.name;
  nameInp.placeholder = 'Quotation name';
  nameInp.addEventListener('input', () => {
    q.name = nameInp.value || 'Untitled';
    save();
    renderBars();
  });

  const jobSel = document.createElement('select');
  (Array.isArray(JOB_TYPES) ? JOB_TYPES : []).forEach((j) => {
    const o = document.createElement('option');
    o.value = j.id;
    o.textContent = j.name;
    jobSel.appendChild(o);
  });
  jobSel.value = q.jobTypeId;
  jobSel.addEventListener('change', () => {
    if (!confirm('Change job type for this quotation? All item fields will reset.')) {
      jobSel.value = q.jobTypeId;
      return;
    }
    q.jobTypeId = jobSel.value;
    const def = defaultValuesFor(jobTypeById(q.jobTypeId));
    if (!Array.isArray(q.items)) q.items = [];
    q.items.forEach((it) => (it.values = { ...def }));
    save();
    renderSafe();
  });

  const taxInp = document.createElement('input');
  taxInp.type = 'number';
  taxInp.step = '0.1';
  taxInp.min = '0';
  taxInp.value = state.taxPct;
  taxInp.title = 'Tax % (global)';
  taxInp.addEventListener('input', () => {
    state.taxPct = num(taxInp.value, 0);
    save();
    renderSafe();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'ghost';
  delBtn.textContent = 'Delete quotation';
  delBtn.addEventListener('click', () => {
    if (!confirm('Delete this quotation?')) return;
    const idx = state.quotations.findIndex((x) => x.id === q.id);
    if (idx >= 0) state.quotations.splice(idx, 1);
    if (!state.quotations.length) state.quotations.push(newQuotation('Quote 1'));
    state.activeId = state.quotations[0].id;
    save();
    renderSafe();
  });

  // Status chip to show CSV results at a glance
  const statusChip = document.createElement('div');
  statusChip.className = 'chip';
  statusChip.textContent = `Machines: ${Array.isArray(MACHINES) ? MACHINES.length : 0} • JobTypes: ${Array.isArray(JOB_TYPES) ? JOB_TYPES.length : 0}`;

  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'primary';
  addItemBtn.textContent = '+ Add Item';
  addItemBtn.addEventListener('click', () => {
    console.log('[ui] Add Item clicked');
    try {
      const jtNow = jobTypeById(q.jobTypeId);
      if (!jtNow || !Array.isArray(jtNow.fields) || jtNow.fields.length === 0) {
        alert('This Job Type has no fields. Check your job_fields_demo.csv (key/label/type...).');
        return;
      }
      if (!Array.isArray(q.items)) q.items = [];
      q.items.push(newItemForQuote(q));
      save();
      renderSafe();
    } catch (e) {
      console.error('[add item] error:', e);
      alert('Could not add item — see console for details.');
    }
  });

  header.append(
    labelWrap('Name', nameInp),
    labelWrap('Job Type', jobSel),
    labelWrap('Tax % (global)', taxInp),
    mkSpacer(),
    statusChip,
    addItemBtn,
    delBtn
  );

  // If job type has no fields, fail-soft with a clear message
  if (!jt || !Array.isArray(jt.fields) || jt.fields.length === 0) {
    editorEl.innerHTML = '';
    editorEl.append(header);
    const msg = document.createElement('div');
    msg.className = 'pairBox';
    msg.innerHTML = `
      <div class="muted">The selected Job Type has no fields to render.</div>
      <div class="help">Check <code>data/job_fields_demo.csv</code> headers: <code>job_type_id, job_type_name, key, label, type, min, step, default</code>.</div>
    `;
    editorEl.append(msg);
    return;
  }

  const list = document.createElement('div');
  (Array.isArray(q.items) ? q.items : []).forEach((it, i) => list.appendChild(renderItemCard(q, it, i)));

  const foot = document.createElement('div');
  foot.className = 'totals';
  foot.innerHTML = `
    <div class="card"><div class="muted">Subtotal</div><div class="big">₱ ${qTotals.subtotal.toLocaleString()}</div></div>
    <div class="card"><div class="muted">Tax (${state.taxPct}%)</div><div class="big">₱ ${qTotals.tax.toLocaleString()}</div></div>
    <div class="card"><div class="muted">Grand Total</div><div class="big">₱ ${qTotals.grand.toLocaleString()}</div></div>
  `;

  editorEl.innerHTML = '';
  editorEl.append(header, list, foot);
}

function renderItemCard(q, it, idx) {
  const jt = jobTypeById(q.jobTypeId);
  const card = document.createElement('div');
  card.className = 'pairBox';

  const head = document.createElement('div');
  head.className = 'pairHead';
  const title = document.createElement('div');
  title.innerHTML = `<strong>Item ${idx + 1}</strong> — <span class="muted">${machineById(it.machineId).name}</span>`;

  const machineSel = document.createElement('select');
  (Array.isArray(MACHINES) ? MACHINES : []).forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    machineSel.appendChild(o);
  });
  machineSel.value = it.machineId;
  machineSel.addEventListener('change', () => {
    it.machineId = machineSel.value;
    save();
    renderBars();
  });

  const right = document.createElement('div');
  right.className = 'right';
  const dupBtn = document.createElement('button');
  dupBtn.textContent = 'Duplicate';
  dupBtn.addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(it));
    copy.id = newId('it');
    q.items.splice(idx + 1, 0, copy);
    save();
    renderEditor(); // OK to call directly inside editor
  });
  const remBtn = document.createElement('button');
  remBtn.textContent = 'Remove';
  remBtn.addEventListener('click', () => {
    if (!confirm('Remove this item?')) return;
    q.items.splice(idx, 1);
    save();
    renderSafe();
  });
  right.append(dupBtn, remBtn);

  head.append(title, machineSel, right);

  const grid = document.createElement('div');
  grid.className = 'fieldGrid';
  jt.fields.forEach((f) => {
    const box = document.createElement('div');
    box.className = 'fieldCard';
    const lab = document.createElement('div');
    lab.textContent = f.label;
    lab.className = 'muted';
    lab.style.marginBottom = '6px';
    const inp = document.createElement('input');
    inp.type = f.type || 'text';
    if (f.min !== undefined) inp.min = String(f.min);
    if (f.step !== undefined) inp.step = String(f.step);
    inp.value = it.values[f.key] ?? '';
    inp.addEventListener('input', () => {
      it.values[f.key] = inp.value;
      save();
      renderBars();
      updateTotal();
    });
    box.append(lab, inp);
    grid.appendChild(box);
  });

  const totalRow = document.createElement('div');
  totalRow.style.display = 'flex';
  totalRow.style.justifyContent = 'flex-end';
  totalRow.style.gap = '10px';
  const totalChip = document.createElement('div');
  totalChip.className = 'chip';
  totalChip.textContent = 'Item total: ₱ 0';
  totalRow.appendChild(totalChip);

  function updateTotal() {
    const t = computeItemTotal(q, it);
    totalChip.textContent = `Item total: ₱ ${t.toLocaleString()}`;
    save();
    renderBars();
  }
  updateTotal();

  card.append(head, grid, totalRow);
  return card;
}

// ================================================================
// Totals
// ================================================================
function computeItemTotal(q, it) {
  const jt = jobTypeById(q.jobTypeId);
  try { return round(jt.compute(it)); } catch { return 0; }
}
function computeQuotationTotals(q) {
  let subtotal = 0;
  (Array.isArray(q.items) ? q.items : []).forEach((it) => (subtotal += computeItemTotal(q, it)));
  const tax = round(subtotal * (num(state.taxPct, 0) / 100));
  return { subtotal: round(subtotal), tax, grand: round(subtotal + tax) };
}
function computeSummaryTotals() {
  let grand = 0, sub = 0, tax = 0;
  state.quotations.forEach((q) => {
    const t = computeQuotationTotals(q);
    sub += t.subtotal;
    tax += t.tax;
    grand += t.grand;
  });
  return { subtotal: round(sub), tax: round(tax), grandTotal: round(grand) };
}

// ================================================================
// Small helpers
// ================================================================
function mkSpacer() {
  const s = document.createElement('div');
  s.className = 'spacer';
  return s;
}
function labelWrap(lbl, el) {
  const w = document.createElement('div');
  const l = document.createElement('div');
  l.className = 'muted';
  l.textContent = lbl;
  w.append(l, el);
  return w;
}

// ================================================================
// Boot (robust): paint immediately, then refresh after CSVs load
// ================================================================
function renderSafe() {
  try {
    renderBars();
    renderEditor();
  } catch (e) {
    console.error('[render] error:', e);
    const editor = document.getElementById('editor');
    if (editor) editor.innerHTML = '<div class="chip" style="margin:8px 0">Render error — check console</div>';
  }
}

// 1) Initial paint (placeholders or saved state)
renderSafe();

// 2) Load CSVs (optional). Even if they 404, we re-render with what we have.
(async () => {
  const tasks = [loadDemoMachines(), loadDemoJobTypes()];
  const results = await Promise.allSettled(tasks);
  console.log('[boot] CSV load results:', results);
  renderSafe();
})();
