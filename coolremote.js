const BASE_URL = 'https://api.coolremote.net/api/v2';
const APP_ID = 'coolAutomationControl';

class CoolRemoteClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async _ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    const res = await fetch(`${BASE_URL}/users/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password, appId: APP_ID }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error(`CoolRemote authentication failed: ${body.message || res.status}`);
    }

    this.token = body.data.token;
    const payload = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64').toString('utf8'));
    this.tokenExpiresAt = payload.exp * 1000;
    return this.token;
  }

  async _request(path, { method = 'GET', body: requestBody, retryOn401 = true } = {}) {
    const token = await this._ensureToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'x-access-token': token,
        'content-type': 'application/json',
        // The account has no official API access (enableAPI: false), so the
        // server gates requests by Origin instead of an API key. This mirrors
        // what the web app (control.coolremote.net) sends.
        Origin: 'https://control.coolremote.net',
        Referer: 'https://control.coolremote.net/site',
      },
      body: requestBody != null ? JSON.stringify(requestBody) : undefined,
    });

    if (res.status === 401 && retryOn401) {
      this.token = null;
      return this._request(path, { method, body: requestBody, retryOn401: false });
    }

    const responseBody = await res.json();
    if (!res.ok || responseBody.success === false) {
      throw new Error(`CoolRemote request failed (${path}): ${responseBody.message || res.status}`);
    }
    return responseBody.data;
  }

  async getCustomers() {
    const data = await this._request('/customers');
    return Object.values(data);
  }

  async getSites(customerId) {
    const data = await this._request(`/customers/${customerId}/sites`);
    return Object.values(data);
  }

  async getGroups(siteId) {
    const data = await this._request(`/sites/${siteId}/groups`);
    return Object.values(data);
  }

  async getUnits(siteId) {
    const data = await this._request(`/sites/${siteId}/units?type=1`);
    return Object.values(data);
  }

  async getSchedules(customerId) {
    const data = await this._request(`/customers/${customerId}/schedules`);
    return Object.values(data);
  }

  // Updates an existing schedule. Fields left out of `payload` are preserved
  // server-side (e.g. group/units membership) — this mirrors what the
  // CoolRemote web app's own "Edit Schedule" form sends (verified by
  // inspecting its network request), which only includes the fields the
  // form itself exposes: isDisabled, name, powerOnTime, powerOffTime,
  // setpoint, scheduleCategory, fanMode, days.
  async updateSchedule(scheduleId, payload) {
    return this._request(`/schedules/${scheduleId}`, { method: 'PUT', body: payload });
  }

  // Actual historical runtime, hour by hour, for one unit — as opposed to
  // getSchedules(), which is the *planned* recurring timer.
  async getUnitHourlyStats(unitId, startTimeUTC, endTimeUTC, bucketSizeMsec = 3_600_000) {
    const path = `/service-params/units/${unitId}/stats/basic/summary?startTimeUTC=${startTimeUTC}&endTimeUTC=${endTimeUTC}&bucketSizeMsec=${bucketSizeMsec}`;
    const data = await this._request(path);
    return data.buckets || [];
  }
}

module.exports = { CoolRemoteClient };
