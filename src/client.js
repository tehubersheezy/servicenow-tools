'use strict';

require('dotenv').config();

const TableApi = require('./table');
const AggregateApi = require('./aggregate');

/**
 * Accept either a full URL or a bare instance name and return a usable origin.
 * A bare name is what `now-sdk auth --add` takes, so it's the form most likely
 * to end up in .env by hand — but `new URL(path, 'dev12345')` throws, which
 * surfaces as a confusing "Invalid URL" on the first request instead of here.
 *
 *   'dev12345'                          -> 'https://dev12345.service-now.com'
 *   'dev12345.service-now.com'          -> 'https://dev12345.service-now.com'
 *   'https://dev12345.service-now.com/' -> 'https://dev12345.service-now.com'
 */
function normalizeInstanceUrl(value) {
  const raw = (value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.includes('.') ? raw : `${raw}.service-now.com`}`;
}

class ServiceNowClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.instanceUrl] - defaults to SN_INSTANCE_URL env
   * @param {string} [opts.username]    - defaults to SN_USERNAME env
   * @param {string} [opts.password]    - defaults to SN_PASSWORD env
   */
  constructor(opts = {}) {
    this.instanceUrl = normalizeInstanceUrl(opts.instanceUrl || process.env.SN_INSTANCE_URL);
    const username = opts.username || process.env.SN_USERNAME;
    const password = opts.password || process.env.SN_PASSWORD;

    if (!this.instanceUrl) throw new Error('ServiceNow instance URL is required (SN_INSTANCE_URL)');
    if (!username || !password) throw new Error('ServiceNow credentials are required (SN_USERNAME / SN_PASSWORD)');

    this._authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  /** Return a TableApi bound to a specific table. */
  table(tableName) {
    return new TableApi(this, tableName);
  }

  /** Return an AggregateApi bound to a specific table. */
  aggregate(tableName) {
    return new AggregateApi(this, tableName);
  }

  /**
   * Core HTTP request method.
   * @param {string} path   - URL path (appended to instanceUrl)
   * @param {object} [opts]
   * @param {string} [opts.method]  - HTTP method (default GET)
   * @param {object} [opts.params]  - Query parameters
   * @param {object} [opts.body]    - JSON request body
   * @param {object} [opts.headers] - Extra/overriding request headers
   * @returns {Promise<{status: number, headers: object, data: any}>}
   */
  async request(path, { method = 'GET', params = {}, body, headers: extraHeaders } = {}) {
    const url = new URL(path, this.instanceUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    // Accept defaults to JSON, but not every endpoint can produce it — e.g.
    // /api/now/doc/oas_3 answers 406 to an application/json Accept and serves
    // the spec as application/octet-stream. Callers can override per request.
    const headers = {
      Authorization: this._authHeader,
      Accept: 'application/json',
      ...extraHeaders,
    };

    const fetchOpts = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), fetchOpts);

    let data;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const err = new Error(`ServiceNow ${method} ${path} failed: ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    // Preserve pagination-relevant headers
    const responseHeaders = {};
    for (const name of ['link', 'x-total-count']) {
      const val = res.headers.get(name);
      if (val) responseHeaders[name] = val;
    }

    return { status: res.status, headers: responseHeaders, data };
  }

  // Convenience methods
  get(path, opts) { return this.request(path, { ...opts, method: 'GET' }); }
  post(path, opts) { return this.request(path, { ...opts, method: 'POST' }); }
  put(path, opts) { return this.request(path, { ...opts, method: 'PUT' }); }
  patch(path, opts) { return this.request(path, { ...opts, method: 'PATCH' }); }
  delete(path, opts) { return this.request(path, { ...opts, method: 'DELETE' }); }
}

module.exports = ServiceNowClient;
