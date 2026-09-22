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
const tabButtons = document.querySelectorAll('.tab-btn[data-tab]');
const viewButtons = document.querySelectorAll('.view-btn[data-view]');
const detailButtons = document.querySelectorAll('.detail-btn[data-detail]');
const themeButtons = document.querySelectorAll('.theme-btn[data-theme]');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let activeTab = 'schedule';
let viewMode = 'daily';
let detailMode = 'compact';

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

// Greedily packs possibly-overlapping segments into vertical lanes so
// nothing gets hidden when two schedules cover the same time range.
function assignLanes(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const laneEnds = [];
  for (const seg of sorted) {
    let lane = laneEnds.findIndex((end) => end <= seg.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(seg.end);
    } else {
      laneEnds[lane] = seg.end;
    }
    seg.lane = lane;
  }
  return { segments: sorted, laneCount: Math.max(1, laneEnds.length) };
}

const LANE_HEIGHT_DETAILED = 56;
const LANE_HEIGHT_COMPACT = 34;
const LANE_GAP = 6;

function segmentIsHeat(seg) {
  return seg.mode === 'Heat' || seg.mode === 'Heat/Heat' || seg.mode === 'Aux heat' || seg.mode === 'Heating';
}

function segmentClass(seg, kind) {
  if (segmentIsHeat(seg)) return 'heat';
  if (kind === 'history' && seg.mode === 'Running') return 'running';
  return 'cool';
}

// Describes one raw schedule/history segment in full, used both as the
// detailed-mode inline text source and as every mode's tooltip.
function describeSegment(seg, kind) {
  const time = `${timeLabel(seg.start)}–${timeLabel(seg.end)}`;
  if (kind === 'schedule') {
    const detailParts = [];
    if (seg.setpoint != null) detailParts.push(`${seg.setpoint}°C`);
    if (seg.fan) detailParts.push(`${seg.fan} fan`);
    const extra = detailParts.length ? ` · ${detailParts.join(' · ')}` : '';
    const groupPart = seg.group ? ` (${seg.group})` : '';
    return `${seg.source}${groupPart}\n${time}${extra}`;
  }
  return `${time} · ${seg.mode} (actual compressor activity — CoolRemote's runtime stats don't report setpoint/fan)`;
}

// Off markers are schedules with only a powerOffTime (no powerOnTime) — a
// bare "shut off" action, often set on a broad parent group. They don't
// define an on-period, so they're drawn as a single instant, not a block.
function describeOffMarker(marker) {
  const groupPart = marker.group ? ` (${marker.group})` : '';
  return `${marker.source}${groupPart}\nShuts off at ${timeLabel(marker.time)}`;
}

// Unions overlapping/touching segments into single blocks, for the compact
// view where several schedules covering the same time range collapse into
// one row instead of stacking lanes.
function mergeSegments(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
      last.sources.push(seg);
    } else {
      merged.push({ start: seg.start, end: seg.end, sources: [seg] });
    }
  }
  return merged;
}

function positionEl(el, start, end, top, height) {
  el.style.left = `${(start / 1440) * 100}%`;
  el.style.width = `${((end - start) / 1440) * 100}%`;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
}

function buildCompactBar(bar, segments, kind) {
  bar.style.height = `${LANE_HEIGHT_COMPACT}px`;
  for (const block of mergeSegments(segments)) {
    const el = document.createElement('div');
    el.className = `segment compact ${block.sources.some((s) => segmentClass(s, kind) === 'heat') ? 'heat' : 'cool'}`;
    positionEl(el, block.start, block.end, LANE_GAP / 2, LANE_HEIGHT_COMPACT - LANE_GAP);

    const time = `${timeLabel(block.start)}–${timeLabel(block.end)}`;
    const countLabel = block.sources.length > 1 ? ` (${block.sources.length})` : '';
    el.innerHTML = `<span class="segment-time">${time}${countLabel}</span>`;
    el.title = block.sources.map((seg) => describeSegment(seg, kind)).join('\n\n');
    bar.appendChild(el);
  }
}

function buildDetailedBar(bar, segments, kind) {
  const { segments: laid, laneCount } = assignLanes(segments);
  bar.style.height = `${laneCount * LANE_HEIGHT_DETAILED + LANE_GAP}px`;

  for (const seg of laid) {
    const el = document.createElement('div');
    el.className = `segment ${segmentClass(seg, kind)}`;
    positionEl(el, seg.start, seg.end, seg.lane * LANE_HEIGHT_DETAILED + LANE_GAP / 2, LANE_HEIGHT_DETAILED - LANE_GAP);

    const time = `${timeLabel(seg.start)}–${timeLabel(seg.end)}`;
    if (kind === 'schedule') {
      const detailParts = [];
      if (seg.setpoint != null) detailParts.push(`${seg.setpoint}°C`);
      if (seg.fan) detailParts.push(`${seg.fan} fan`);
      el.innerHTML = `
        <span class="segment-time">${time}</span>
        <span class="segment-detail">${detailParts.join(' · ')}</span>
        <span class="segment-source">${seg.source}${seg.group ? ` · ${seg.group}` : ''}</span>
      `;
    } else {
      el.innerHTML = `
        <span class="segment-time">${time}</span>
        <span class="segment-detail">${seg.mode}</span>
      `;
    }
    el.title = describeSegment(seg, kind);
    bar.appendChild(el);
  }
}

function addOffMarkers(bar, offMarkers) {
  for (const marker of offMarkers) {
    const el = document.createElement('div');
    el.className = 'off-marker';
    el.style.left = `${(marker.time / 1440) * 100}%`;
    el.title = describeOffMarker(marker);
    bar.appendChild(el);
  }
}

function buildTimelineBar(segments, offMarkers, kind) {
  const bar = document.createElement('div');
  bar.className = 'timeline-bar';

  const track = document.createElement('div');
  track.className = 'track';
  bar.appendChild(track);

  if (segments.length > 0) {
    if (detailMode === 'compact') buildCompactBar(bar, segments, kind);
    else buildDetailedBar(bar, segments, kind);
  } else {
    bar.style.height = `${LANE_HEIGHT_COMPACT}px`;
  }

  addOffMarkers(bar, offMarkers);

  return bar;
}

function buildGroupBlock(group, kind) {
  const block = document.createElement('div');
  block.className = 'group-block';

  const header = document.createElement('div');
  header.className = 'group-header';
  header.textContent = `${group.name} (${group.unitCount})`;
  block.appendChild(header);

  for (const dayEntry of group.days) {
    const row = document.createElement('div');
    row.className = 'day-row';

    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = dayEntry.date ? `${dayEntry.day} · ${dayEntry.date}` : dayEntry.day;
    row.appendChild(label);

    const offMarkers = dayEntry.offMarkers || [];
    if (dayEntry.segments.length === 0 && offMarkers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'timeline-bar empty';
      empty.innerHTML = '<div class="track"></div><span class="no-activity">Off all day</span>';
      row.appendChild(empty);
    } else {
      row.appendChild(buildTimelineBar(dayEntry.segments, offMarkers, kind));
    }
    block.appendChild(row);
  }

  return block;
}

function buildAxis() {
  const axis = document.createElement('div');
  axis.className = 'axis';
  for (let h = 0; h <= 24; h += 3) {
    const tick = document.createElement('span');
    tick.textContent = pad2(h % 24);
    axis.appendChild(tick);
  }
  return axis;
}

function renderGroups(groups, kind) {
  wrapEl.appendChild(buildAxis());
  const list = document.createElement('div');
  list.className = 'groups-list';
  for (const group of groups) list.appendChild(buildGroupBlock(group, kind));
  wrapEl.appendChild(list);
  renderLegend(kind);
}

function renderLegend(kind) {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <span><span class="swatch" style="background:var(--off)"></span>Off</span>
    <span><span class="swatch" style="background:var(--on-grad)"></span>Cooling</span>
    <span><span class="swatch" style="background:var(--heat-grad)"></span>Heating</span>
    ${kind === 'schedule' ? '<span><span class="swatch off-marker-swatch"></span>Shutoff-only schedule</span>' : ''}
    ${kind === 'history' ? '<span class="legend-note">Times shown to the nearest 5 minutes, from actual runtime.</span>' : ''}
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

let lastRender = null; // { groups, kind, statusText } — cached so toggling Compact/Detailed doesn't refetch

function renderCached() {
  if (!lastRender) return;
  wrapEl.innerHTML = '';
  renderGroups(lastRender.groups, lastRender.kind);
  setStatus(lastRender.statusText);
}

async function loadSchedule(dayName) {
  const data = await apiGet(`/api/timeline?day=${dayName}&mode=${viewMode}`);
  timezoneLabel.textContent = data.timezone ? `(${data.timezone})` : '';
  if (data.groups.length === 0) return setStatus('No groups found.');
  const statusText =
    viewMode === 'weekly'
      ? `Showing recurring weekly schedule — ${data.groups.length} locations`
      : `Showing recurring schedule for ${dayName} — ${data.groups.length} locations`;
  lastRender = { groups: data.groups, kind: 'schedule', statusText };
  renderGroups(data.groups, 'schedule');
  setStatus(statusText);
}

async function loadHistory(dateStr) {
  const data = await apiGet(`/api/history?date=${dateStr}&mode=${viewMode}`);
  timezoneLabel.textContent = data.timezone ? `(${data.timezone})` : '';
  if (data.groups.length === 0) return setStatus('No groups found.');
  const statusText =
    viewMode === 'weekly'
      ? `Showing actual runtime for the week of ${dateStr} — ${data.groups.length} locations`
      : `Showing actual runtime for ${dateStr} — ${data.groups.length} locations`;
  lastRender = { groups: data.groups, kind: 'history', statusText };
  renderGroups(data.groups, 'history');
  setStatus(statusText);
}

async function refresh() {
  lastRender = null;
  setStatus('Loading…');
  wrapEl.innerHTML = '';
  try {
    if (activeTab === 'schedule') await loadSchedule(dayPicker.value);
    else await loadHistory(datePicker.value);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function updateControlsVisibility() {
  dayPicker.classList.toggle('hidden', !(activeTab === 'schedule' && viewMode === 'daily'));
  datePicker.classList.toggle('hidden', activeTab !== 'history');
}

function setTab(tab) {
  activeTab = tab;
  tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  updateControlsVisibility();
  pageTitle.textContent = tab === 'schedule' ? 'Air Conditioning — Weekly Schedule' : 'Air Conditioning — Actual History';
  refresh();
}

function setView(view) {
  viewMode = view;
  viewButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  updateControlsVisibility();
  refresh();
}

function setDetailMode(mode) {
  detailMode = mode;
  detailButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.detail === mode));
  renderCached();
}

function setTheme(theme) {
  themeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.theme === theme));
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem('ac-theme', theme);
  } catch (err) {}
}

tabButtons.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
viewButtons.forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
detailButtons.forEach((btn) => btn.addEventListener('click', () => setDetailMode(btn.dataset.detail)));
themeButtons.forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
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
