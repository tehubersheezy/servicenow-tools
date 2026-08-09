'use strict';

/**
 * graphql-sdl — render introspection type objects as GraphQL SDL text.
 *
 * Used by scrape-graphql.js to write the human-readable .graphql file next to
 * each namespace's introspection .json. Input is the standard introspection
 * shape (__Type objects with fields/args/inputFields/enumValues/possibleTypes).
 */

const BUILTIN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/** Render a TypeRef ({kind, name, ofType}) as SDL: [Int!]! etc. */
function typeRef(ref) {
  if (!ref) return '';
  if (ref.kind === 'NON_NULL') return typeRef(ref.ofType) + '!';
  if (ref.kind === 'LIST') return '[' + typeRef(ref.ofType) + ']';
  return ref.name || '';
}

function descBlock(text, indent) {
  if (!text) return '';
  // Triple-quote blocks; escape an embedded """ so it can't close the block.
  const safe = String(text).replace(/"""/g, '\\"""');
  if (!safe.includes('\n')) return indent + '"""' + safe + '"""\n';
  return indent + '"""\n' + safe.split('\n').map((l) => indent + l).join('\n') + '\n' + indent + '"""\n';
}

function renderArgs(args) {
  if (!args || !args.length) return '';
  const parts = args.map((a) => {
    let s = a.name + ': ' + typeRef(a.type);
    if (a.defaultValue !== null && a.defaultValue !== undefined) s += ' = ' + a.defaultValue;
    return s;
  });
  const oneLine = '(' + parts.join(', ') + ')';
  if (oneLine.length <= 80) return oneLine;
  return '(\n' + parts.map((p) => '    ' + p).join('\n') + '\n  )';
}

function deprecation(node) {
  if (!node.isDeprecated) return '';
  return node.deprecationReason
    ? ' @deprecated(reason: ' + JSON.stringify(node.deprecationReason) + ')'
    : ' @deprecated';
}

function renderFields(fields) {
  return fields.map((f) => {
    let out = descBlock(f.description, '  ');
    out += '  ' + f.name + renderArgs(f.args) + ': ' + typeRef(f.type) + deprecation(f) + '\n';
    return out;
  }).join('');
}

function renderInputFields(fields) {
  return fields.map((f) => {
    let out = descBlock(f.description, '  ');
    let line = '  ' + f.name + ': ' + typeRef(f.type);
    if (f.defaultValue !== null && f.defaultValue !== undefined) line += ' = ' + f.defaultValue;
    return out + line + '\n';
  }).join('');
}

/** Render one introspection type object as an SDL declaration, or '' to skip. */
function renderType(t) {
  if (!t || !t.name || t.name.startsWith('__')) return '';
  if (t.kind === 'SCALAR' && BUILTIN_SCALARS.has(t.name)) return '';

  const head = descBlock(t.description, '');
  switch (t.kind) {
    case 'SCALAR':
      return head + 'scalar ' + t.name + '\n';
    case 'ENUM':
      return head + 'enum ' + t.name + ' {\n' +
        (t.enumValues || []).map((v) =>
          descBlock(v.description, '  ') + '  ' + v.name + deprecation(v) + '\n').join('') +
        '}\n';
    case 'UNION':
      return head + 'union ' + t.name + ' = ' +
        (t.possibleTypes || []).map(typeRef).join(' | ') + '\n';
    case 'INPUT_OBJECT':
      return head + 'input ' + t.name + ' {\n' + renderInputFields(t.inputFields || []) + '}\n';
    case 'INTERFACE':
    case 'OBJECT': {
      const kw = t.kind === 'INTERFACE' ? 'interface ' : 'type ';
      const impl = (t.interfaces || []).length
        ? ' implements ' + t.interfaces.map(typeRef).join(' & ')
        : '';
      return head + kw + t.name + impl + ' {\n' + renderFields(t.fields || []) + '}\n';
    }
    default:
      return '';
  }
}

/**
 * Render a set of types as one SDL document. Root types (the namespace's
 * query/mutation containers) come first so the file reads top-down; everything
 * else follows alphabetically.
 */
function renderSchema(types, rootNames = []) {
  const rootRank = new Map(rootNames.map((n, i) => [n, i]));
  const sorted = types.slice().sort((a, b) => {
    const ra = rootRank.has(a.name) ? rootRank.get(a.name) : Infinity;
    const rb = rootRank.has(b.name) ? rootRank.get(b.name) : Infinity;
    return ra - rb || a.name.localeCompare(b.name);
  });
  return sorted.map(renderType).filter(Boolean).join('\n');
}

module.exports = { renderSchema, renderType, typeRef };
