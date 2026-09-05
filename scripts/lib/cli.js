'use strict';

function argValue(argv, name, fallback = '') {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function numberArg(argv, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = argValue(argv, name, '');
  const value = raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseStrict(argv, schema = {}) {
  const out = { positional: [] };
  for (const [name, spec] of Object.entries(schema)) out[name] = spec.default;

  const byFlag = new Map();
  for (const [name, spec] of Object.entries(schema)) {
    for (const flag of spec.flags || []) byFlag.set(flag, { name, spec });
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out.positional.push(token);
      continue;
    }
    const entry = byFlag.get(token);
    if (!entry) throw new Error(`未知参数: ${token}`);
    const { name, spec } = entry;
    if (spec.type === 'boolean') {
      out[name] = spec.value === undefined ? true : spec.value;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`参数缺少值: ${token}`);
    const raw = argv[++i];
    if (spec.type === 'number') {
      let value = Number(raw);
      if (!Number.isFinite(value)) value = spec.default;
      if (spec.min !== undefined) value = Math.max(spec.min, value);
      if (spec.max !== undefined) value = Math.min(spec.max, value);
      out[name] = value;
    } else {
      out[name] = raw;
    }
  }
  return out;
}

module.exports = { argValue, hasFlag, numberArg, parseStrict };
