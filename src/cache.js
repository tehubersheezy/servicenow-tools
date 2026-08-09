'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * CacheManager — SQLite-backed local cache for ServiceNow API responses.
 *
 * Schema
 * ------
 * _cache_meta (table_name TEXT PRIMARY KEY, fetched_at TEXT, record_count INTEGER, query TEXT)
 * sn_<tableName> — dynamically created per ServiceNow table; all columns TEXT.
 */
class CacheManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbPath] - Path to SQLite DB file. Defaults to ./data/cache.db
   */
  constructor(opts = {}) {
    const dbPath = opts.dbPath || path.join(process.cwd(), 'data', 'cache.db');

    // Ensure the directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    this._initMeta();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Create the _cache_meta table if it does not yet exist. */
  _initMeta() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS _cache_meta (
        table_name   TEXT PRIMARY KEY,
        fetched_at   TEXT NOT NULL,
        record_count INTEGER NOT NULL DEFAULT 0,
        query        TEXT
      )
    `);
  }

  /**
   * Sanitise a ServiceNow table name so it is safe to embed in SQL identifiers.
   * Allows only word characters (letters, digits, underscore).
   * @param {string} tableName
   * @returns {string} Safe local table name: sn_<tableName>
   */
  _localTable(tableName) {
    if (!/^\w+$/.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}"`);
    }
    return `sn_${tableName}`;
  }

  /**
   * Sanitise a column name for embedding in SQL.
   * Wraps in double-quotes after verifying it contains only safe characters.
   * @param {string} col
   * @returns {string} Quoted identifier
   */
  _col(col) {
    if (!/^\w+$/.test(col)) {
      throw new Error(`Invalid column name: "${col}"`);
    }
    return `"${col}"`;
  }

  /**
   * Build a CREATE TABLE statement from a sample record's keys.
   * All columns are TEXT. sys_id becomes the PRIMARY KEY when present.
   * @param {string} localTable - Already-sanitised local table name
   * @param {string[]} keys     - Column names from the first fetched record
   */
  _buildCreateTable(localTable, keys) {
    const colDefs = keys.map((k) => {
      const quoted = this._col(k);
      return k === 'sys_id' ? `${quoted} TEXT PRIMARY KEY` : `${quoted} TEXT`;
    });
    return `CREATE TABLE "${localTable}" (${colDefs.join(', ')})`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch ALL records for a ServiceNow table and store them locally.
   *
   * Pagination is handled automatically: batches of `batchSize` records are
   * fetched until the total reported by the X-Total-Count header is reached.
   *
   * @param {import('./client')} client       - Authenticated ServiceNowClient
   * @param {string}             tableName    - ServiceNow table name (e.g. 'incident')
   * @param {object}             [opts]
   * @param {string}             [opts.query]       - Encoded sysparm_query filter
   * @param {string}             [opts.fields]      - Comma-separated field list
   * @param {string}             [opts.displayValue] - 'true' | 'false' | 'all'
   * @param {boolean}            [opts.excludeReferenceLink]
   * @param {number}             [opts.batchSize]   - Records per API call (default 500)
   * @returns {Promise<{tableName: string, recordCount: number}>}
   */
  async pull(client, tableName, opts = {}) {
    const { batchSize = 500, query, fields, displayValue, excludeReferenceLink } = opts;

    const localTable = this._localTable(tableName);

    let totalCount = null; // populated from X-Total-Count on first response
    let offset = 0;
    let allRecords = [];

    // ------------------------------------------------------------------
    // Pagination loop
    // ------------------------------------------------------------------
    while (totalCount === null || offset < totalCount) {
      const listOpts = {
        limit: batchSize,
        offset,
      };
      if (query) listOpts.query = query;
      if (fields) listOpts.fields = fields;
      if (displayValue !== undefined) listOpts.displayValue = displayValue;
      if (excludeReferenceLink !== undefined) listOpts.excludeReferenceLink = excludeReferenceLink;

      const response = await client.table(tableName).list(listOpts);

      // X-Total-Count tells us the full result set size
      if (totalCount === null) {
        const countHeader = response.headers['x-total-count'];
        totalCount = countHeader !== undefined ? parseInt(countHeader, 10) : null;
      }

      const batch = (response.data && response.data.result) ? response.data.result : [];

      if (batch.length === 0) break; // no more records

      allRecords = allRecords.concat(batch);
      offset += batch.length;

      // If the API did not return a total count header, stop when a
      // batch comes back smaller than the requested batch size.
      if (totalCount === null && batch.length < batchSize) break;
    }

    // ------------------------------------------------------------------
    // Persist to SQLite (full refresh — drop + recreate)
    // ------------------------------------------------------------------
    const recordCount = allRecords.length;

    // Determine columns from the first record (or skip if empty)
    const keys = recordCount > 0 ? Object.keys(allRecords[0]) : [];

    // Flatten any nested objects/arrays to strings (ServiceNow displayValue=all
    // can return objects like { value: '...', display_value: '...' }).
    const flatten = (record) => {
      const flat = {};
      for (const [k, v] of Object.entries(record)) {
        if (v !== null && typeof v === 'object') {
          flat[k] = JSON.stringify(v);
        } else {
          flat[k] = v === null || v === undefined ? null : String(v);
        }
      }
      return flat;
    };

    const insertAll = this._db.transaction((records) => {
      // Drop existing table and recreate for a clean refresh
      this._db.exec(`DROP TABLE IF EXISTS "${localTable}"`);

      if (keys.length === 0) {
        // Nothing to insert — create a minimal placeholder table
        this._db.exec(`CREATE TABLE "${localTable}" (_empty INTEGER)`);
      } else {
        this._db.exec(this._buildCreateTable(localTable, keys));

        const colList = keys.map((k) => this._col(k)).join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        const stmt = this._db.prepare(
          `INSERT OR REPLACE INTO "${localTable}" (${colList}) VALUES (${placeholders})`
        );

        for (const record of records) {
          const flat = flatten(record);
          const values = keys.map((k) => (flat[k] !== undefined ? flat[k] : null));
          stmt.run(...values);
        }
      }

      // Update metadata
      this._db.prepare(`
        INSERT OR REPLACE INTO _cache_meta (table_name, fetched_at, record_count, query)
        VALUES (?, ?, ?, ?)
      `).run(tableName, new Date().toISOString(), recordCount, query || null);
    });

    insertAll(allRecords);

    return { tableName, recordCount };
  }

  /**
   * Query a locally cached ServiceNow table.
   *
   * @param {string} tableName
   * @param {object} [opts]
   * @param {string}   [opts.where]   - SQL WHERE clause (without the WHERE keyword)
   * @param {any[]}    [opts.params]  - Bound parameters for the where clause
   * @param {string[]} [opts.fields]  - Column names to SELECT (default: all)
   * @param {number}   [opts.limit]   - Max rows to return
   * @param {number}   [opts.offset]  - Row offset
   * @param {string}   [opts.orderBy] - ORDER BY expression (e.g. 'sys_created_on DESC')
   * @returns {object[]} Array of row objects
   */
  query(tableName, opts = {}) {
    const { where, params = [], fields, limit, offset, orderBy } = opts;
    const localTable = this._localTable(tableName);

    let select;
    if (fields && fields.length > 0) {
      select = fields.map((f) => this._col(f)).join(', ');
    } else {
      select = '*';
    }

    let sql = `SELECT ${select} FROM "${localTable}"`;
    if (where) sql += ` WHERE ${where}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit !== undefined) sql += ` LIMIT ${parseInt(limit, 10)}`;
    if (offset !== undefined) sql += ` OFFSET ${parseInt(offset, 10)}`;

    return this._db.prepare(sql).all(...params);
  }

  /**
   * Return the number of rows in a cached table, optionally filtered.
   *
   * @param {string} tableName
   * @param {object} [opts]
   * @param {string} [opts.where]  - SQL WHERE clause (without WHERE keyword)
   * @param {any[]}  [opts.params] - Bound parameters
   * @returns {number}
   */
  count(tableName, opts = {}) {
    const { where, params = [] } = opts;
    const localTable = this._localTable(tableName);

    let sql = `SELECT COUNT(*) AS cnt FROM "${localTable}"`;
    if (where) sql += ` WHERE ${where}`;

    const row = this._db.prepare(sql).get(...params);
    return row ? row.cnt : 0;
  }

  /**
   * List all cached tables and their metadata.
   *
   * @returns {{ table_name: string, fetched_at: string, record_count: number, query: string|null }[]}
   */
  tables() {
    return this._db.prepare(`
      SELECT table_name, fetched_at, record_count, query
      FROM _cache_meta
      ORDER BY table_name
    `).all();
  }

  /**
   * Drop a cached table and remove its metadata entry.
   *
   * @param {string} tableName - ServiceNow table name (not the sn_ prefixed one)
   */
  drop(tableName) {
    const localTable = this._localTable(tableName);
    this._db.exec(`DROP TABLE IF EXISTS "${localTable}"`);
    this._db.prepare(`DELETE FROM _cache_meta WHERE table_name = ?`).run(tableName);
  }

  /**
   * Close the underlying SQLite database connection.
   */
  close() {
    this._db.close();
  }
}

module.exports = CacheManager;
