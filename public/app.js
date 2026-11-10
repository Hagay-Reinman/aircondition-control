const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const roleBadge = document.getElementById('role-badge');

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
const inactiveToggleEl = document.getElementById('inactive-toggle');
const inactiveButtons = document.querySelectorAll('.inactive-btn[data-inactive]');

const editModal = document.getElementById('edit-modal');
const editModalTitle = document.getElementById('edit-modal-title');
const editModalClose = document.getElementById('edit-modal-close');
const editStatusEl = document.getElementById('edit-status');
const editStatusButtons = document.querySelectorAll('.status-toggle[data-status]');
const editDaysEl = document.getElementById('edit-days');
const editStartEl = document.getElementById('edit-start');
const editEndEl = document.getElementById('edit-end');
const editSetpointEl = document.getElementById('edit-setpoint');
const editFanEl = document.getElementById('edit-fan');
const editModeEl = document.getElementById('edit-mode');
const createFieldsEl = document.getElementById('create-fields');
const editNameEl = document.getElementById('edit-name');
const editGroupEl = document.getElementById('edit-group');
const newScheduleBtn = document.getElementById('new-schedule-btn');
const editTypeButtons = document.querySelectorAll('.type-toggle[data-type]');
const startFieldEl = document.getElementById('start-field');
const editEndLabelEl = document.getElementById('edit-end-label');
const onFieldsEl = document.getElementById('on-fields');
const offOnlyHintEl = document.getElementById('offonly-hint');
const editErrorEl = document.getElementById('edit-error');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const editSaveBtn = document.getElementById('edit-save-btn');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };

// Mirrors the server's FAN_MODE_LABELS (CoolAutomation FanMode enum), ordered
// low to high rather than by numeric value.
const FAN_MODES = [
  { value: 5, label: 'Very low' },
  { value: 0, label: 'Low' },
  { value: 1, label: 'Medium' },
  { value: 2, label: 'High' },
  { value: 6, label: 'Super high' },
  { value: 4, label: 'Top' },
  { value: 3, label: 'Auto' },
];

// Modes a schedule can set. CoolRemote only accepts Cool (0) or Heat (1) on
// schedules ("run_mode must be one of [0, 1]"). '' means the schedule
// doesn't touch the mode (the unit keeps whatever mode it was last in).
const SCHEDULE_MODES = [
  { value: '', label: "Don't change" },
  { value: 0, label: 'Cool' },
  { value: 1, label: 'Heat' },
];

let activeTab = 'schedule';
let viewMode = 'daily';
let detailMode = 'compact';
let showInactive = false;
let isAdmin = false;

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
    if (seg.mode) detailParts.push(seg.mode);
    const extra = detailParts.length ? ` · ${detailParts.join(' · ')}` : '';
    const groupPart = seg.group ? ` (${seg.group})` : '';
    const inactivePart = seg.isDisabled ? ' · Inactive' : '';
    return `${seg.source}${groupPart}\n${time}${extra}${inactivePart}`;
  }
  return `${time} · ${seg.mode} (actual compressor activity — CoolRemote's runtime stats don't report setpoint/fan)`;
}

// Off markers are schedules with only a powerOffTime (no powerOnTime) — a
// bare "shut off" action, often set on a broad parent group. They don't
// define an on-period, so they're drawn as a single instant, not a block.
function describeOffMarker(marker) {
  const groupPart = marker.group ? ` (${marker.group})` : '';
  const inactivePart = marker.isDisabled ? ' · Inactive' : '';
  return `${marker.source}${groupPart}\nShuts off at ${timeLabel(marker.time)}${inactivePart}`;
}

// Collapses overlapping schedules into the actual on/off state of the unit,
// for the compact view. Each schedule independently issues an ON command at
// its start and an OFF command at its end — the unit isn't "on if any
// schedule says on", it's simply whatever the most recent command set it
// to. So e.g. a 06:00–24:00 schedule plus a 10:00–12:00 schedule on the same
// unit actually only runs 06:00–12:00: the second schedule's OFF at 12:00
// overrides the first, and nothing turns it on again after that.
function mergeSegments(segments) {
  if (segments.length === 0) return [];
  const events = [];
  for (const seg of segments) {
    events.push({ time: seg.start, on: true });
    events.push({ time: seg.end, on: false });
  }
  // At a tie, apply OFF before ON — so a schedule that starts exactly when
  // another ends reads as one continuous on-period, not a momentary gap.
  events.sort((a, b) => a.time - b.time || (a.on === b.on ? 0 : a.on ? 1 : -1));

  const onIntervals = [];
  let isOn = false;
  let blockStart = null;
  for (const ev of events) {
    if (ev.on && !isOn) {
      isOn = true;
      blockStart = ev.time;
    } else if (!ev.on && isOn) {
      isOn = false;
      if (ev.time > blockStart) onIntervals.push({ start: blockStart, end: ev.time });
    }
  }

  // Adjacent intervals split only by tie-breaking (no real gap) collapse
  // back into one block.
  const merged = [];
  for (const iv of onIntervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }

  for (const block of merged) {
    block.sources = segments.filter((seg) => seg.start < block.end && seg.end > block.start);
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
    const blockInactive = kind === 'schedule' && block.sources.every((s) => s.isDisabled);
    el.className = `segment compact ${block.sources.some((s) => segmentClass(s, kind) === 'heat') ? 'heat' : 'cool'}${blockInactive ? ' inactive' : ''}`;
    positionEl(el, block.start, block.end, LANE_GAP / 2, LANE_HEIGHT_COMPACT - LANE_GAP);

    const time = `${timeLabel(block.start)}–${timeLabel(block.end)}`;
    const countLabel = block.sources.length > 1 ? ` (${block.sources.length})` : '';
    el.innerHTML = `<span class="segment-time">${time}${countLabel}</span>`;
    el.title = block.sources.map((seg) => describeSegment(seg, kind)).join('\n\n');
    if (kind === 'schedule' && isAdmin) {
      el.classList.add('editable');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (block.sources.length === 1) openEditModal(block.sources[0]);
        else openSourcePicker(e, block.sources);
      });
    }
    bar.appendChild(el);
  }
}

function buildDetailedBar(bar, segments, kind) {
  const { segments: laid, laneCount } = assignLanes(segments);
  bar.style.height = `${laneCount * LANE_HEIGHT_DETAILED + LANE_GAP}px`;

  for (const seg of laid) {
    const el = document.createElement('div');
    el.className = `segment ${segmentClass(seg, kind)}${kind === 'schedule' && seg.isDisabled ? ' inactive' : ''}`;
    positionEl(el, seg.start, seg.end, seg.lane * LANE_HEIGHT_DETAILED + LANE_GAP / 2, LANE_HEIGHT_DETAILED - LANE_GAP);

    const time = `${timeLabel(seg.start)}–${timeLabel(seg.end)}`;
    if (kind === 'schedule') {
      const detailParts = [];
      if (seg.setpoint != null) detailParts.push(`${seg.setpoint}°C`);
      if (seg.fan) detailParts.push(`${seg.fan} fan`);
      if (seg.mode) detailParts.push(seg.mode);
      if (seg.isDisabled) detailParts.push('Inactive');
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
    if (kind === 'schedule' && isAdmin) {
      el.classList.add('editable');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(seg);
      });
    }
    bar.appendChild(el);
  }
}

function addOffMarkers(bar, offMarkers) {
  for (const marker of offMarkers) {
    const el = document.createElement('div');
    el.className = `off-marker${marker.isDisabled ? ' inactive' : ''}`;
    el.style.left = `${(marker.time / 1440) * 100}%`;
    el.title = describeOffMarker(marker);
    if (isAdmin) {
      el.classList.add('editable');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSourcePicker();
        openEditModal(marker);
      });
    }
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
    ${kind === 'schedule' && showInactive ? '<span><span class="swatch inactive-swatch"></span>Inactive schedule</span>' : ''}
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

async function apiSend(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Session expired — please log in again.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function timeToMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTimeValue(minutes) {
  return timeLabel(Math.min(minutes, 1439));
}

// --- Schedule editing ---

let editingSchedule = null;
let activePicker = null;

function closeSourcePicker() {
  if (activePicker) {
    activePicker.remove();
    activePicker = null;
    document.removeEventListener('click', closeSourcePicker);
  }
}

// Compact view can merge several overlapping schedules into one block —
// this lets the user pick which one they meant to click.
function openSourcePicker(event, sources) {
  closeSourcePicker();
  const menu = document.createElement('div');
  menu.className = 'segment-picker';
  for (const seg of sources) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${seg.source}${seg.group ? ` (${seg.group})` : ''} · ${timeLabel(seg.start)}–${timeLabel(seg.end)}${seg.isDisabled ? ' · Inactive' : ''}`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSourcePicker();
      openEditModal(seg);
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let left = event.clientX;
  let top = event.clientY;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  activePicker = menu;
  setTimeout(() => document.addEventListener('click', closeSourcePicker), 0);
}

function renderDayToggles(activeDays) {
  editDaysEl.innerHTML = '';
  for (const day of DAY_NAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `day-toggle${activeDays.includes(day) ? ' active' : ''}`;
    btn.textContent = DAY_SHORT[day];
    btn.dataset.day = day;
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    editDaysEl.appendChild(btn);
  }
}

// Snapshot of the form's state, used to detect unsaved changes on close.
function editFormState() {
  const days = [...editDaysEl.querySelectorAll('.day-toggle.active')].map((b) => b.dataset.day).sort();
  const isDisabled = [...editStatusButtons].find((b) => b.classList.contains('active'))?.dataset.status === 'inactive';
  return JSON.stringify({
    isDisabled,
    offOnly: isOffOnly(),
    days,
    start: editStartEl.value,
    end: editEndEl.value,
    setpoint: editSetpointEl.value,
    fanMode: editFanEl.value,
    operationMode: editModeEl.value,
    name: isCreating ? editNameEl.value : null,
    groupId: isCreating ? editGroupEl.value : null,
  });
}

let editInitialState = null;
let isCreating = false;

function isOffOnly() {
  return [...editTypeButtons].find((b) => b.classList.contains('active'))?.dataset.type === 'offonly';
}

// Off-only schedules have just an off time — no start, temperature, fan or mode.
function setScheduleType(offOnly) {
  editTypeButtons.forEach((b) => b.classList.toggle('active', (b.dataset.type === 'offonly') === offOnly));
  startFieldEl.classList.toggle('hidden', offOnly);
  onFieldsEl.classList.toggle('hidden', offOnly);
  offOnlyHintEl.classList.toggle('hidden', !offOnly);
  editEndLabelEl.textContent = offOnly ? 'Off time' : 'End time';
}

// Any other stored mode shows as "Don't change", so saving never sends a
// value CoolRemote would reject.
function renderModeOptions(currentMode) {
  editModeEl.innerHTML = SCHEDULE_MODES.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  editModeEl.value = currentMode === 0 || currentMode === 1 ? String(currentMode) : '';
}

// Fills the shared form fields. `seg` is an existing schedule segment, or a
// blank defaults object when creating.
function fillScheduleForm(seg) {
  editStatusButtons.forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.status === 'inactive') === !!seg.isDisabled);
  });
  renderDayToggles(seg.days || []);
  const offOnly = seg.rawStart == null;
  setScheduleType(offOnly);
  // An off-only schedule has no start; prefill one in case it's switched to on & off.
  editStartEl.value = minutesToTimeValue(offOnly ? 8 * 60 : seg.rawStart);
  editEndEl.value = minutesToTimeValue(offOnly ? seg.time : seg.rawEnd);
  editSetpointEl.value = seg.setpoint != null ? seg.setpoint : 22;
  editFanEl.innerHTML = FAN_MODES.map((f) => `<option value="${f.value}">${f.label}</option>`).join('');
  editFanEl.value = seg.fanMode != null ? seg.fanMode : 3;
  renderModeOptions(seg.operationMode);
  editErrorEl.textContent = '';
}

function openEditModal(seg) {
  isCreating = false;
  editingSchedule = seg;
  createFieldsEl.classList.add('hidden');
  editModalTitle.textContent = seg.group ? `Edit — ${seg.source} (${seg.group})` : `Edit — ${seg.source}`;
  editSaveBtn.textContent = 'Save';
  fillScheduleForm(seg);
  editModal.classList.remove('hidden');
  editInitialState = editFormState();
}

let groupsCache = null;

async function openCreateModal() {
  closeSourcePicker();
  try {
    if (!groupsCache) {
      const overview = await apiGet('/api/overview');
      groupsCache = overview.groups.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  isCreating = true;
  editingSchedule = null;
  createFieldsEl.classList.remove('hidden');
  editModalTitle.textContent = 'New schedule';
  editSaveBtn.textContent = 'Create';
  editNameEl.value = '';
  editGroupEl.innerHTML =
    '<option value="">Choose a group…</option>' +
    groupsCache.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  editGroupEl.value = '';
  const defaultDays = activeTab === 'schedule' && viewMode === 'daily' ? [dayPicker.value] : [];
  fillScheduleForm({ isDisabled: false, days: defaultDays, rawStart: 8 * 60, rawEnd: 18 * 60, setpoint: 24, fanMode: 3, operationMode: 0 });
  editModal.classList.remove('hidden');
  editInitialState = editFormState();
  editNameEl.focus();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function closeEditModal() {
  editModal.classList.add('hidden');
  editingSchedule = null;
  isCreating = false;
  editInitialState = null;
}

// Closes the modal, but warns first if the form was changed and not saved.
function requestCloseEditModal() {
  if (editInitialState !== null && editFormState() !== editInitialState) {
    if (!window.confirm('You have unsaved changes. Discard them?')) return;
  }
  closeEditModal();
}

async function saveEdit() {
  if (!editingSchedule && !isCreating) return;
  const name = editNameEl.value.trim();
  const groupId = editGroupEl.value;
  if (isCreating && !name) {
    editErrorEl.textContent = 'Give the schedule a name.';
    return;
  }
  if (isCreating && !groupId) {
    editErrorEl.textContent = 'Choose which group the schedule applies to.';
    return;
  }
  const days = [...editDaysEl.querySelectorAll('.day-toggle.active')].map((b) => b.dataset.day);
  if (days.length === 0) {
    editErrorEl.textContent = 'Pick at least one day.';
    return;
  }
  const isDisabled = [...editStatusButtons].find((b) => b.classList.contains('active'))?.dataset.status === 'inactive';
  let fields;
  if (isOffOnly()) {
    if (editEndEl.value === '') {
      editErrorEl.textContent = 'Off time is required.';
      return;
    }
    fields = { days, powerOnTime: null, powerOffTime: timeToMinutes(editEndEl.value), isDisabled };
  } else {
    if (editStartEl.value === '' || editEndEl.value === '') {
      editErrorEl.textContent = 'Start and end time are required.';
      return;
    }
    const powerOnTime = timeToMinutes(editStartEl.value);
    const powerOffTime = timeToMinutes(editEndEl.value);
    if (powerOnTime === powerOffTime) {
      editErrorEl.textContent = 'Start and end time can\'t be the same.';
      return;
    }
    const setpoint = Number(editSetpointEl.value);
    if (Number.isNaN(setpoint)) {
      editErrorEl.textContent = 'Enter a valid temperature.';
      return;
    }
    const fanMode = Number(editFanEl.value);
    const operationMode = editModeEl.value === '' ? null : Number(editModeEl.value);
    fields = { days, powerOnTime, powerOffTime, setpoint, fanMode, operationMode, isDisabled };
  }

  editSaveBtn.disabled = true;
  editErrorEl.textContent = '';
  try {
    const result = isCreating
      ? await apiSend('POST', '/api/schedules', { ...fields, name, groupId })
      : await apiSend('PUT', `/api/schedules/${editingSchedule.id}`, fields);
    closeEditModal();
    await refresh();
    if (result.modeApplied === false) {
      setStatus('Saved, but CoolRemote did not keep the mode change — the schedule still has its previous mode.', true);
    }
  } catch (err) {
    editErrorEl.textContent = err.message;
  } finally {
    editSaveBtn.disabled = false;
  }
}

editTypeButtons.forEach((btn) => {
  btn.addEventListener('click', () => setScheduleType(btn.dataset.type === 'offonly'));
});
editStatusButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    editStatusButtons.forEach((b) => b.classList.toggle('active', b === btn));
  });
});
editModalClose.addEventListener('click', requestCloseEditModal);
editCancelBtn.addEventListener('click', requestCloseEditModal);
editSaveBtn.addEventListener('click', saveEdit);
newScheduleBtn.addEventListener('click', openCreateModal);
editModal.addEventListener('click', (e) => {
  if (e.target === editModal) requestCloseEditModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !editModal.classList.contains('hidden')) requestCloseEditModal();
});

let lastRender = null; // { groups, kind, statusText } — cached so toggling Compact/Detailed doesn't refetch

function renderCached() {
  if (!lastRender) return;
  wrapEl.innerHTML = '';
  renderGroups(lastRender.groups, lastRender.kind);
  setStatus(lastRender.statusText);
}

async function loadSchedule(dayName) {
  const data = await apiGet(`/api/timeline?day=${dayName}&mode=${viewMode}&includeInactive=${showInactive}`);
  timezoneLabel.textContent = data.timezone ? `(${data.timezone})` : '';
  if (data.groups.length === 0) return setStatus('No groups found.');
  const inactiveNote = showInactive ? ' (including inactive)' : '';
  const statusText =
    viewMode === 'weekly'
      ? `Showing recurring weekly schedule${inactiveNote} — ${data.groups.length} locations`
      : `Showing recurring schedule for ${dayName}${inactiveNote} — ${data.groups.length} locations`;
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
  inactiveToggleEl.classList.toggle('hidden', activeTab !== 'schedule');
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

function setInactiveVisible(show) {
  showInactive = show;
  inactiveButtons.forEach((btn) => btn.classList.toggle('active', (btn.dataset.inactive === 'show') === show));
  refresh();
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
inactiveButtons.forEach((btn) => btn.addEventListener('click', () => setInactiveVisible(btn.dataset.inactive === 'show')));
themeButtons.forEach((btn) => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
refreshBtn.addEventListener('click', refresh);
dayPicker.addEventListener('change', refresh);
datePicker.addEventListener('change', refresh);

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
}

function showApp(role) {
  isAdmin = role === 'admin';
  roleBadge.textContent = isAdmin ? 'Admin' : 'View only';
  roleBadge.classList.toggle('viewer', !isAdmin);
  newScheduleBtn.classList.toggle('hidden', !isAdmin);
  groupsCache = null;
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
    showApp(data.role);
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
  if (data.authenticated) showApp(data.role);
  else showLogin();
})();
