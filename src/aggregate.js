'use strict';

class AggregateApi {
  /**
   * @param {import('./client')} client
   * @param {string} tableName
   */
  constructor(client, tableName) {
    this._client = client;
    this._table = tableName;
    this._basePath = `/api/now/stats/${tableName}`;
  }

  /**
   * Run an aggregate query.
   * @param {object} [opts]
   * @param {string}  [opts.query]        - Encoded query filter
   * @param {boolean} [opts.count]        - Include record count
   * @param {string}  [opts.avgFields]    - Comma-separated fields for AVG
   * @param {string}  [opts.minFields]    - Comma-separated fields for MIN
   * @param {string}  [opts.maxFields]    - Comma-separated fields for MAX
   * @param {string}  [opts.sumFields]    - Comma-separated fields for SUM
   * @param {string}  [opts.groupBy]      - Comma-separated fields to group by
   * @param {string}  [opts.orderBy]      - Comma-separated fields to order by
   * @param {string}  [opts.having]       - Aggregate filter expression
   * @param {string}  [opts.displayValue] - true | false | all
   */
  query(opts = {}) {
    const params = {};
    const map = {
      query:        'sysparm_query',
      count:        'sysparm_count',
      avgFields:    'sysparm_avg_fields',
      minFields:    'sysparm_min_fields',
      maxFields:    'sysparm_max_fields',
      sumFields:    'sysparm_sum_fields',
      groupBy:      'sysparm_group_by',
      orderBy:      'sysparm_order_by',
      having:       'sysparm_having',
      displayValue: 'sysparm_display_value',
      queryCategory:'sysparm_query_category',
    };

    for (const [key, sysparm] of Object.entries(map)) {
      if (opts[key] !== undefined) {
        params[sysparm] = opts[key];
      }
    }

    return this._client.get(this._basePath, { params });
  }
}

module.exports = AggregateApi;
