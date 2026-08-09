'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const ServiceNowClient = require('./client');
const CacheManager = require('./cache');

const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// ServiceNow client
// ---------------------------------------------------------------------------

const client = new ServiceNowClient();
const cache = new CacheManager();

// ---------------------------------------------------------------------------
// Query-param helpers
// ---------------------------------------------------------------------------

/**
 * Extract table-related options from Express query params (camelCase keys).
 * @param {object} query - req.query
 * @returns {object}
 */
function tableOptsFromQuery(query) {
  const opts = {};
  const keys = [
    'query',
    'fields',
    'limit',
    'offset',
    'displayValue',
    'view',
    'excludeReferenceLink',
    'suppressPaginationHeader',
    'noCount',
  ];
  for (const key of keys) {
    if (query[key] !== undefined) {
      opts[key] = query[key];
    }
  }
  return opts;
}

/**
 * Extract aggregate-related options from Express query params (camelCase keys).
 * @param {object} query - req.query
 * @returns {object}
 */
function aggregateOptsFromQuery(query) {
  const opts = {};
  const keys = [
    'query',
    'count',
    'avgFields',
    'minFields',
    'maxFields',
    'sumFields',
    'groupBy',
    'orderBy',
    'having',
    'displayValue',
  ];
  for (const key of keys) {
    if (query[key] !== undefined) {
      opts[key] = query[key];
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Table routes
// ---------------------------------------------------------------------------

// GET /api/table/:table — list records
app.get('/api/table/:table', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).list(tableOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// GET /api/table/:table/:sysId — get single record
app.get('/api/table/:table/:sysId', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).get(req.params.sysId, tableOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// POST /api/table/:table — create record
app.post('/api/table/:table', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).create(req.body, tableOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/table/:table/:sysId — partial update
app.patch('/api/table/:table/:sysId', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).update(req.params.sysId, req.body, tableOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// PUT /api/table/:table/:sysId — full replacement
app.put('/api/table/:table/:sysId', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).replace(req.params.sysId, req.body, tableOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/table/:table/:sysId — delete record
app.delete('/api/table/:table/:sysId', async (req, res, next) => {
  try {
    const result = await client.table(req.params.table).delete(req.params.sysId);
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Aggregate routes
// ---------------------------------------------------------------------------

// GET /api/stats/:table — aggregate query
app.get('/api/stats/:table', async (req, res, next) => {
  try {
    const result = await client.aggregate(req.params.table).query(aggregateOptsFromQuery(req.query));
    res.status(result.status).set(result.headers).json(result.data);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Cache routes
// ---------------------------------------------------------------------------

// POST /api/cache/:table/pull — fetch from ServiceNow and store in SQLite
app.post('/api/cache/:table/pull', async (req, res, next) => {
  try {
    const opts = tableOptsFromQuery(req.query);
    if (req.query.batchSize) opts.batchSize = Number(req.query.batchSize);
    const result = await cache.pull(client, req.params.table, opts);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/cache — list all cached tables
app.get('/api/cache', (_req, res) => {
  res.json({ tables: cache.tables() });
});

// GET /api/cache/:table/count — count rows in cached table
app.get('/api/cache/:table/count', (req, res, next) => {
  try {
    const { where, params } = req.query;
    const opts = {};
    if (where) opts.where = where;
    if (params) opts.params = params.split(',');
    res.json({ table: req.params.table, count: cache.count(req.params.table, opts) });
  } catch (err) {
    next(err);
  }
});

// GET /api/cache/:table — query cached table
app.get('/api/cache/:table', (req, res, next) => {
  try {
    const { where, params, fields, limit, offset, orderBy } = req.query;
    const opts = {};
    if (where) opts.where = where;
    if (params) opts.params = params.split(',');
    if (fields) opts.fields = fields.split(',');
    if (limit) opts.limit = Number(limit);
    if (offset) opts.offset = Number(offset);
    if (orderBy) opts.orderBy = orderBy;
    const rows = cache.query(req.params.table, opts);
    res.json({ table: req.params.table, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cache/:table — drop cached table
app.delete('/api/cache/:table', (req, res, next) => {
  try {
    cache.drop(req.params.table);
    res.json({ success: true, table: req.params.table });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handling middleware
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(status).json({ error: { message, status } });
});

// ---------------------------------------------------------------------------
// Start server (only when run directly)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`ServiceNow proxy server listening on port ${port}`);
  });
}

module.exports = app;
