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

// Turns a day's on/off schedule events (in minutes-since-midnight) into a
// minute-by-minute on/off timeline, starting from "off" at minute 0.
function simulateDayMinutes(events) {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const minutes = new Array(1440).fill(0);
  let state = false;
  let cursor = 0;
  for (const ev of sorted) {
    if (state) minutes.fill(1, cursor, ev.time);
    state = ev.type === 'on';
    cursor = ev.time;
  }
  if (state) minutes.fill(1, cursor, 1440);
  return minutes;
}

function minutesToHourlyFractions(minutes) {
  return Array.from({ length: 24 }, (_, hour) => {
    const slice = minutes.slice(hour * 60, hour * 60 + 60);
    const onFraction = slice.reduce((sum, v) => sum + v, 0) / 60;
    return { hour, onFraction };
  });
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
app.get('/api/timeline', requireAuth, async (req, res) => {
  try {
    const { customer, site } = await getFirstCustomerAndSite(req.client);
    const timezone = site.timezone || 'UTC';
    const dayName = DAY_NAMES.includes(req.query.day)
      ? req.query.day
      : DAY_NAMES[DateTime.now().setZone(timezone).weekday % 7];

    const [groups, units, schedules] = await Promise.all([
      req.client.getGroups(site.id),
      req.client.getUnits(site.id),
      req.client.getSchedules(customer.id),
    ]);
    const groupById = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    const { leafGroupScope, leafGroupUnits } = buildLeafGroups(units, groupById);

    const activeSchedules = schedules.filter((s) => !s.isDisabled && (s.days || []).includes(dayName));

    const groupOutput = [...leafGroupScope.entries()].map(([leafId, scope]) => {
      const events = [];
      for (const schedule of activeSchedules) {
        if (!scope.has(schedule.group)) continue;
        if (schedule.powerOnTime != null) events.push({ time: schedule.powerOnTime, type: 'on' });
        if (schedule.powerOffTime != null) events.push({ time: schedule.powerOffTime, type: 'off' });
      }
      const minutes = simulateDayMinutes(events);
      return {
        id: leafId,
        name: groupById[leafId],
        unitCount: leafGroupUnits.get(leafId).length,
        hours: minutesToHourlyFractions(minutes),
      };
    });

    res.json({ day: dayName, timezone, groups: groupOutput });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Actual history: what really ran, hour by hour, on a specific calendar date.
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { site } = await getFirstCustomerAndSite(req.client);
    const timezone = site.timezone || 'UTC';
    const dateStr = req.query.date || DateTime.now().setZone(timezone).toISODate();

    const dayStart = DateTime.fromISO(dateStr, { zone: timezone }).startOf('day');
    const dayEnd = dayStart.plus({ days: 1 });

    const [groups, units] = await Promise.all([req.client.getGroups(site.id), req.client.getUnits(site.id)]);
    const groupById = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    const { leafGroupUnits } = buildLeafGroups(units, groupById);

    const unitHours = await mapWithConcurrency(units, 4, async (unit) => {
      const hours = Array.from({ length: 24 }, () => 0);
      try {
        const buckets = await req.client.getUnitHourlyStats(unit.id, dayStart.toMillis(), dayEnd.toMillis());
        for (const bucket of buckets) {
          const hour = DateTime.fromMillis(bucket.timestamp, { zone: timezone }).hour;
          hours[hour] = Math.min(1, (bucket.unitBucketOnTime || 0) / 3_600_000);
        }
      } catch (err) {
        console.warn(`History unavailable for unit ${unit.name} (${unit.id}): ${err.message}`);
      }
      return { unitId: unit.id, hours };
    });
    const hoursByUnitId = new Map(unitHours.map((u) => [u.unitId, u.hours]));

    const groupOutput = [...leafGroupUnits.entries()].map(([leafId, memberUnits]) => {
      const hourSums = Array(24).fill(0);
      for (const unit of memberUnits) {
        (hoursByUnitId.get(unit.id) || []).forEach((v, h) => { hourSums[h] += v; });
      }
      return {
        id: leafId,
        name: groupById[leafId],
        unitCount: memberUnits.length,
        hours: hourSums.map((sum, hour) => ({ hour, onFraction: sum / memberUnits.length })),
      };
    });

    res.json({ date: dateStr, timezone, groups: groupOutput });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Aircondition timeline running at http://localhost:${PORT}`));
