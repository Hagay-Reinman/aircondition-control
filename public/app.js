const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const statusEl = document.getElementById('status');
const wrapEl = document.getElementById('timeline-wrap');
const dayPicker = document.getElementById('day-picker');
const datePicker = document.getElementById('date-picker');
const timezoneLabel = document.getElementById('timezone-label');
const refreshBtn = document.getElementById('refresh-btn');
const pageTitle = document.getElementById('page-title');
const tabButtons = document.querySelectorAll('.tab-btn');

let activeTab = 'schedule';

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

function buildTable(groups) {
  const table = document.createElement('table');
  table.className = 'timeline';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  for (let h = 0; h < 24; h++) {
    const th = document.createElement('th');
    th.textContent = String(h).padStart(2, '0');
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const group of groups) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.className = 'unit-name';
    nameCell.textContent = `${group.name} (${group.unitCount})`;
    row.appendChild(nameCell);

    const byHour = new Map(group.hours.map((h) => [h.hour, h.onFraction]));
    for (let h = 0; h < 24; h++) {
      const fraction = byHour.get(h) || 0;
      const cell = document.createElement('td');
      cell.className = 'hour-cell';
      cell.title = `${group.name} — ${String(h).padStart(2, '0')}:00 — ${Math.round(fraction * 100)}% on`;
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.background = `rgba(52, 211, 153, ${fraction})`;
      cell.appendChild(fill);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function renderLegend(onLabel) {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <span><span class="swatch" style="background:rgba(55,42,85,1)"></span>Off</span>
    <span class="gradient-legend">
      <span>Partial hour</span>
      <span class="gradient-bar"></span>
      <span>${onLabel}</span>
    </span>
  `;
  wrapEl.appendChild(legend);
}

async function apiGet(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired — please log in again.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadSchedule(dayName) {
  const data = await apiGet(`/api/timeline?day=${dayName}`);
  timezoneLabel.textContent = data.timezone ? `(${data.timezone})` : '';
  if (data.groups.length === 0) return setStatus('No groups found.');
  wrapEl.appendChild(buildTable(data.groups));
  renderLegend('Full hour');
  setStatus(`Showing recurring schedule for ${dayName} — ${data.groups.length} locations`);
}

async function loadHistory(dateStr) {
  const data = await apiGet(`/api/history?date=${dateStr}`);
  timezoneLabel.textContent = data.timezone ? `(${data.timezone})` : '';
  if (data.groups.length === 0) return setStatus('No groups found.');
  wrapEl.appendChild(buildTable(data.groups));
  renderLegend('Full hour');
  setStatus(`Showing actual runtime for ${dateStr} — ${data.groups.length} locations`);
}

async function refresh() {
  setStatus('Loading…');
  wrapEl.innerHTML = '';
  try {
    if (activeTab === 'schedule') await loadSchedule(dayPicker.value);
    else await loadHistory(datePicker.value);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setTab(tab) {
  activeTab = tab;
  tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  dayPicker.classList.toggle('hidden', tab !== 'schedule');
  datePicker.classList.toggle('hidden', tab !== 'history');
  pageTitle.textContent = tab === 'schedule' ? 'Air Conditioning — Weekly Schedule' : 'Air Conditioning — Actual History';
  refresh();
}

tabButtons.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
refreshBtn.addEventListener('click', refresh);
dayPicker.addEventListener('change', refresh);
datePicker.addEventListener('change', refresh);

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  dayPicker.value = DAY_NAMES[new Date().getDay()];
  datePicker.value = new Date().toISOString().slice(0, 10);
  setTab('schedule');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

(async function init() {
  const res = await fetch('/api/session');
  const data = await res.json();
  if (data.authenticated) showApp();
  else showLogin();
})();
