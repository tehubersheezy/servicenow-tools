'use strict';

class TableApi {
  /**
   * @param {import('./client')} client
   * @param {string} tableName
   */
  constructor(client, tableName) {
    this._client = client;
    this._table = tableName;
    this._basePath = `/api/now/table/${tableName}`;
  }

  /**
   * Retrieve multiple records.
   * @param {object} [opts]
   * @param {string} [opts.query]        - Encoded query string
   * @param {string} [opts.fields]       - Comma-separated field list
   * @param {number} [opts.limit]        - Max results per page
   * @param {number} [opts.offset]       - Starting record index
   * @param {string} [opts.displayValue] - true | false | all
   * @param {string} [opts.view]         - UI view name
   * @param {boolean} [opts.excludeReferenceLink]
   * @param {boolean} [opts.suppressPaginationHeader]
   * @param {boolean} [opts.noCount]
   */
  list(opts = {}) {
    return this._client.get(this._basePath, {
      params: mapTableParams(opts),
    });
  }

  /**
   * Retrieve a single record by sys_id.
   */
  get(sysId, opts = {}) {
    return this._client.get(`${this._basePath}/${sysId}`, {
      params: mapTableParams(opts),
    });
  }

  /**
   * Create a new record.
   * @param {object} record - Field values for the new record
   */
  create(record, opts = {}) {
    return this._client.post(this._basePath, {
      params: mapTableParams(opts),
      body: record,
    });
  }

  /**
   * Partial update (PATCH) of a record.
   */
  update(sysId, record, opts = {}) {
    return this._client.patch(`${this._basePath}/${sysId}`, {
      params: mapTableParams(opts),
      body: record,
    });
  }

  /**
   * Full replacement (PUT) of a record.
   */
  replace(sysId, record, opts = {}) {
    return this._client.put(`${this._basePath}/${sysId}`, {
      params: mapTableParams(opts),
      body: record,
    });
  }

  /**
   * Delete a record by sys_id.
   */
  delete(sysId) {
    return this._client.delete(`${this._basePath}/${sysId}`);
  }
}

/**
 * Map friendly camelCase option names to ServiceNow sysparm_* query params.
 */
function mapTableParams(opts) {
  const params = {};
  const map = {
    query:                     'sysparm_query',
    fields:                    'sysparm_fields',
    limit:                     'sysparm_limit',
    offset:                    'sysparm_offset',
    displayValue:              'sysparm_display_value',
    view:                      'sysparm_view',
    excludeReferenceLink:      'sysparm_exclude_reference_link',
    suppressPaginationHeader:  'sysparm_suppress_pagination_header',
    noCount:                   'sysparm_no_count',
    queryCategory:             'sysparm_query_category',
    queryNoDomain:             'sysparm_query_no_domain',
    inputDisplayValue:         'sysparm_input_display_value',
    suppressAutoSysField:      'sysparm_suppress_auto_sys_field',
  };

  for (const [key, sysparm] of Object.entries(map)) {
    if (opts[key] !== undefined) {
      params[sysparm] = opts[key];
    }
  }
  return params;
}

module.exports = TableApi;
