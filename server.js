require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { DateTime } = require('luxon');
const { CoolRemoteClient } = require('./coolremote');

const { PORT = 3000, SESSION_SECRET } = process.env;

const app = express();
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// CoolRemote clients (and their auth tokens) live only in server memory,
// keyed by session id — nothing is written to disk.
const clientsBySession = new Map();

function requireAuth(req, res, next) {
  const client = clientsBySession.get(req.session.id);
  if (!client) return res.status(401).json({ error: 'Not logged in' });
  req.client = client;
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/session', (req, res) => {
  res.json({ authenticated: clientsBySession.has(req.session.id) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const client = new CoolRemoteClient(username, password);
  try {
    await client._ensureToken();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid CoolRemote username or password' });
  }
  clientsBySession.set(req.session.id, client);
  // Force express-session to persist (and send Set-Cookie) — with
  // saveUninitialized:false it otherwise skips saving an untouched session.
  req.session.username = username;
  res.json({ authenticated: true });
});

app.post('/api/logout', (req, res) => {
  clientsBySession.delete(req.session.id);
  req.session.destroy(() => res.json({ authenticated: false }));
});

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// CoolRemote FanMode / OperationMode enums (from the CoolAutomation v2 API spec).
const FAN_MODE_LABELS = { 0: 'Low', 1: 'Medium', 2: 'High', 3: 'Auto', 4: 'Top', 5: 'Very low', 6: 'Super high', 14: 'Off' };
const OPERATION_MODE_LABELS = { 0: 'Cool', 1: 'Heat', 2: 'Auto', 3: 'Dry', 4: 'Aux heat', 5: 'Fan', 6: 'Heat/Heat', 7: 'Auto' };

async function getFirstCustomerAndSite(client) {
  const [customer] = await client.getCustomers();
  const [site] = await client.getSites(customer.id);
  return { customer, site };
}

// Runs async unit stats fetches with a concurrency cap so we don't hammer the API.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Groups units by their most-specific ("leaf") group, and hands back each
// leaf group's full ancestor scope (used to resolve schedules set on a
// parent group, e.g. "All men", down to each specific location).
function buildLeafGroups(units, groupById) {
  const leafGroupScope = new Map();
  const leafGroupUnits = new Map();
  for (const unit of units) {
    const leafId = (unit.groups || [])[0];
    if (!leafId || !groupById[leafId]) continue;
    if (!leafGroupUnits.has(leafId)) leafGroupUnits.set(leafId, []);
    leafGroupUnits.get(leafId).push(unit);
    if (!leafGroupScope.has(leafId)) leafGroupScope.set(leafId, new Set());
    const scope = leafGroupScope.get(leafId);
    for (const gid of unit.groups || []) scope.add(gid);
  }
  return { leafGroupScope, leafGroupUnits };
}

// Turns a day's active schedules into on/off segments with exact start/end
// times (minutes since midnight), keeping each schedule's own name/setpoint/
// fan so the UI can show which schedule produced each block. Schedules that
// cross midnight (powerOffTime < powerOnTime) are split into two segments.
// A schedule with only a powerOffTime (no powerOnTime) doesn't define an "on"
// period at all — e.g. a blanket "shut everything off" schedule set on a
// parent group like "הכל" (All) — so it can't become a segment; it's handed
// back separately as an offMarker (a single instant) instead of being dropped.
function buildScheduleSegments(schedulesForDay, groupById) {
  const segments = [];
  const offMarkers = [];
  for (const schedule of schedulesForDay) {
    const detail = {
      id: schedule.id,
      source: schedule.name,
      group: groupById[schedule.group] || null,
      setpoint: schedule.setpoint,
      fan: FAN_MODE_LABELS[schedule.fanMode] || null,
      fanMode: schedule.fanMode,
      mode: OPERATION_MODE_LABELS[schedule.runMode] || null,
      days: schedule.days || [],
      isDisabled: !!schedule.isDisabled,
      // The schedule's own start/end, independent of `start`/`end` below —
      // which get split at midnight for display and so can't be edited from
      // directly (a midnight-crossing schedule renders as two segments).
      rawStart: schedule.powerOnTime,
      rawEnd: schedule.powerOffTime != null ? schedule.powerOffTime : 1440,
    };
    if (schedule.powerOnTime == null) {
      if (schedule.powerOffTime != null) offMarkers.push({ time: schedule.powerOffTime, ...detail });
      continue;
    }
    const start = schedule.powerOnTime;
    const rawEnd = schedule.powerOffTime != null ? schedule.powerOffTime : 1440;
    if (rawEnd <= start) {
      segments.push({ start, end: 1440, ...detail });
      if (rawEnd > 0) segments.push({ start: 0, end: rawEnd, ...detail });
    } else {
      segments.push({ start, end: rawEnd, ...detail });
    }
  }
  segments.sort((a, b) => a.start - b.start);
  offMarkers.sort((a, b) => a.time - b.time);
  return { segments, offMarkers };
}

// Turns per-5-minute-slot on/cool/heat fractions into contiguous "actually
// ran" segments with exact start/end times, labelled with the dominant
// compressor mode observed during that segment (the runtime-stats API does
// not expose the setpoint/fan the unit was actually using).
function buildHistorySegments(slotOn, slotCool, slotHeat, unitCount, slotMinutes) {
  const segments = [];
  const slotsPerDay = slotOn.length;
  let curStart = null;
  let curCool = 0;
  let curHeat = 0;
  for (let i = 0; i <= slotsPerDay; i++) {
    const isOn = i < slotsPerDay && slotOn[i] / unitCount >= 0.5;
    if (isOn && curStart === null) {
      curStart = i;
      curCool = 0;
      curHeat = 0;
    }
    if (isOn) {
      curCool += slotCool[i];
      curHeat += slotHeat[i];
    }
    if ((!isOn || i === slotsPerDay) && curStart !== null) {
      const mode = curCool === 0 && curHeat === 0 ? 'Running' : curCool >= curHeat ? 'Cooling' : 'Heating';
      segments.push({ start: curStart * slotMinutes, end: i * slotMinutes, mode });
      curStart = null;
    }
  }
  return segments;
}

app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const { site } = await getFirstCustomerAndSite(req.client);
    const [groups, units] = await Promise.all([req.client.getGroups(site.id), req.client.getUnits(site.id)]);
    res.json({
      site: { id: site.id, name: site.name, timezone: site.timezone },
      groups: groups.map((g) => ({ id: g.id, name: g.name, unitIds: g.units })),
      units: units.map((u) => ({ id: u.id, name: u.name, groupIds: u.groups })),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Planned schedule: the recurring weekly on/off timer configured per location.
// mode=daily returns one day's segments; mode=weekly returns all 7 days.
app.get('/api/timeline', requireAuth, async (req, res) => {
  try {
    const { customer, site } = await getFirstCustomerAndSite(req.client);
    const timezone = site.timezone || 'UTC';
    const mode = req.query.mode === 'weekly' ? 'weekly' : 'daily';
    const includeInactive = req.query.includeInactive === 'true';
    const dayName = DAY_NAMES.includes(req.query.day)
      ? req.query.day
      : DAY_NAMES[DateTime.now().setZone(timezone).weekday % 7];
    const dayNames = mode === 'weekly' ? DAY_NAMES : [dayName];

    const [groups, units, schedules] = await Promise.all([
      req.client.getGroups(site.id),
      req.client.getUnits(site.id),
      req.client.getSchedules(customer.id),
    ]);
    const groupById = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    const { leafGroupScope, leafGroupUnits } = buildLeafGroups(units, groupById);

    const groupOutput = [...leafGroupScope.entries()].map(([leafId, scope]) => {
      const days = dayNames.map((dn) => {
        const schedulesForDay = schedules.filter(
          (s) => (includeInactive || !s.isDisabled) && (s.days || []).includes(dn) && scope.has(s.group)
        );
        const { segments, offMarkers } = buildScheduleSegments(schedulesForDay, groupById);
        return { day: dn, segments, offMarkers };
      });
      return { id: leafId, name: groupById[leafId], unitCount: leafGroupUnits.get(leafId).length, days };
    });

    res.json({ mode, day: dayName, timezone, groups: groupOutput });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Edits an existing schedule's days/times/setpoint/fan speed. Only these
// fields are changeable from the timeline UI — name, group/unit membership,
// and enabled state are left exactly as CoolRemote already has them.
app.put('/api/schedules/:id', requireAuth, async (req, res) => {
  try {
    const { customer } = await getFirstCustomerAndSite(req.client);
    const schedules = await req.client.getSchedules(customer.id);
    const schedule = schedules.find((s) => s.id === req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    const { days, powerOnTime, powerOffTime, setpoint, fanMode } = req.body || {};
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => DAY_NAMES.includes(d))) {
      return res.status(400).json({ error: 'days must be a non-empty array of day names' });
    }
    if (!Number.isInteger(powerOnTime) || powerOnTime < 0 || powerOnTime >= 1440) {
      return res.status(400).json({ error: 'powerOnTime must be minutes since midnight (0-1439)' });
    }
    if (!Number.isInteger(powerOffTime) || powerOffTime < 0 || powerOffTime > 1440) {
      return res.status(400).json({ error: 'powerOffTime must be minutes since midnight (0-1440)' });
    }
    if (typeof setpoint !== 'number' || Number.isNaN(setpoint)) {
      return res.status(400).json({ error: 'setpoint must be a number' });
    }
    if (!Number.isInteger(fanMode) || !(fanMode in FAN_MODE_LABELS)) {
      return res.status(400).json({ error: 'Invalid fan mode' });
    }

    const payload = {
      isDisabled: schedule.isDisabled,
      name: schedule.name,
      scheduleCategory: schedule.scheduleCategory,
      powerOnTime,
      powerOffTime,
      setpoint,
      fanMode,
      days,
    };
    await req.client.updateSchedule(req.params.id, payload);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Actual history: what really ran, with exact start/end times, on a specific
// calendar date (mode=daily) or the Sunday–Saturday week containing it
// (mode=weekly).
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { site } = await getFirstCustomerAndSite(req.client);
    const timezone = site.timezone || 'UTC';
    const mode = req.query.mode === 'weekly' ? 'weekly' : 'daily';
    const dateStr = req.query.date || DateTime.now().setZone(timezone).toISODate();
    const anchor = DateTime.fromISO(dateStr, { zone: timezone }).startOf('day');

    const dayCount = mode === 'weekly' ? 7 : 1;
    const rangeStart = mode === 'weekly' ? anchor.minus({ days: anchor.weekday % 7 }) : anchor;
    const rangeEnd = rangeStart.plus({ days: dayCount });
    const dayStarts = Array.from({ length: dayCount }, (_, i) => rangeStart.plus({ days: i }));

    const [groups, units] = await Promise.all([req.client.getGroups(site.id), req.client.getUnits(site.id)]);
    const groupById = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    const { leafGroupUnits } = buildLeafGroups(units, groupById);

    const SLOT_MINUTES = 5;
    const SLOT_MS = SLOT_MINUTES * 60 * 1000;
    const slotsPerDay = (24 * 60) / SLOT_MINUTES;

    const unitDaySlots = await mapWithConcurrency(units, 4, async (unit) => {
      const perDay = Array.from({ length: dayCount }, () => ({
        on: new Array(slotsPerDay).fill(0),
        cool: new Array(slotsPerDay).fill(0),
        heat: new Array(slotsPerDay).fill(0),
      }));
      try {
        const buckets = await req.client.getUnitHourlyStats(unit.id, rangeStart.toMillis(), rangeEnd.toMillis(), SLOT_MS);
        for (const bucket of buckets) {
          const t = DateTime.fromMillis(bucket.timestamp, { zone: timezone });
          const dayIndex = Math.floor(t.diff(rangeStart, 'days').days);
          if (dayIndex < 0 || dayIndex >= dayCount) continue;
          const slot = Math.floor((t.hour * 60 + t.minute) / SLOT_MINUTES);
          if (slot < 0 || slot >= slotsPerDay) continue;
          const day = perDay[dayIndex];
          day.on[slot] = (bucket.unitBucketOnTime || 0) / SLOT_MS;
          day.cool[slot] = (bucket.unitBucketCoolTime || 0) / SLOT_MS;
          day.heat[slot] = (bucket.unitBucketHeatTime || 0) / SLOT_MS;
        }
      } catch (err) {
        console.warn(`History unavailable for unit ${unit.name} (${unit.id}): ${err.message}`);
      }
      return { unitId: unit.id, perDay };
    });
    const slotsByUnitId = new Map(unitDaySlots.map((u) => [u.unitId, u.perDay]));

    const groupOutput = [...leafGroupUnits.entries()].map(([leafId, memberUnits]) => {
      const days = dayStarts.map((dayStart, dayIndex) => {
        const slotOn = new Array(slotsPerDay).fill(0);
        const slotCool = new Array(slotsPerDay).fill(0);
        const slotHeat = new Array(slotsPerDay).fill(0);
        for (const unit of memberUnits) {
          const perDay = slotsByUnitId.get(unit.id);
          if (!perDay) continue;
          const { on, cool, heat } = perDay[dayIndex];
          for (let i = 0; i < slotsPerDay; i++) {
            slotOn[i] += on[i];
            slotCool[i] += cool[i];
            slotHeat[i] += heat[i];
          }
        }
        const segments = buildHistorySegments(slotOn, slotCool, slotHeat, memberUnits.length || 1, SLOT_MINUTES);
        return { day: DAY_NAMES[dayStart.weekday % 7], date: dayStart.toISODate(), segments };
      });
      return { id: leafId, name: groupById[leafId], unitCount: memberUnits.length, days };
    });

    res.json({ mode, date: dateStr, timezone, groups: groupOutput });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Aircondition timeline running at http://localhost:${PORT}`));
