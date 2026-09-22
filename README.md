# Aircondition Control

A small dashboard for [CoolRemote](https://www.coolremote.net/)-managed AC units, showing every location's
recurring schedule and actual runtime as an exact-time timeline instead of CoolRemote's own per-unit views.

## Features

- **Schedule tab** — the recurring weekly on/off timer configured per location, with the setpoint temperature
  and fan speed for each block, labelled with the schedule (and group) that set it.
- **History tab** — what actually ran on a given day, to the nearest 5 minutes, with the inferred
  cooling/heating mode.
- **Daily / Weekly** toggle on both tabs.
- **Compact / Detailed** toggle — compact merges overlapping schedules into one block per row; detailed
  breaks them out onto their own lanes.
- Click any schedule segment to edit it in place — days, start/end time, temperature, and fan speed —
  and save the change straight back to CoolRemote. Editing a schedule set on a shared/parent group affects
  everything that schedule applies to, same as editing it in CoolRemote itself.
- Shutoff-only schedules (a power-off with no power-on, e.g. a blanket "off" schedule on a parent group)
  are shown as an off marker instead of being silently dropped.
- Dark / light theme, persisted locally.

## Setup

```bash
npm install
cp .env.example .env   # then fill in SESSION_SECRET
npm start
```

Open http://localhost:3000 and log in with your CoolRemote username and password.

### Environment variables (`.env`)

| Variable        | Required | Description                                                              |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `PORT`          | No       | Port to listen on. Defaults to `3000`.                                     |
| `SESSION_SECRET` | No      | Secret used to sign the session cookie. A random one is generated at startup if unset, which means sessions won't survive a server restart — set this for a stable login session. |

## How credentials are handled

Your CoolRemote username and password are sent directly to the CoolRemote API to obtain an auth token, which
is kept in server memory only, keyed by session id. Nothing is written to disk, and nothing beyond the
CoolRemote API itself ever sees your credentials.

## Notes

- The first customer and first site on the account are used automatically — this isn't meant for accounts
  managing multiple sites.
- Actual-runtime history comes from an undocumented CoolRemote endpoint (`stats/basic/summary`) that reports
  compressor on/cool/heat time per bucket, not the setpoint or fan speed actually in use — so History segments
  show inferred mode (Cooling/Heating) rather than temperature/fan.
