// Minimal JSON Schema Draft-07 validator — SUBSET only.
// Supports: type (string|number|integer|boolean|array|object|null),
//           enum, const, required, properties, additionalProperties,
//           items, minItems, minLength, pattern, minimum, maximum,
//           oneOf, $ref (internal only), definitions.
// Not supported: dependencies, allOf/anyOf/not, format, multipleOf, ...
// Kept intentionally small to avoid adding a dependency to the repo.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('external $ref not supported: ' + ref);
  const parts = ref.slice(2).split('/');
  let node = root;
  for (const p of parts) {
    if (!isObj(node) || !(p in node)) return null;
    node = node[p];
  }
  return node;
}

function validate(schema, value, root, path, errors) {
  if (!schema) return;
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    if (!target) { errors.push({ path, msg: '$ref not found: ' + schema.$ref }); return; }
    return validate(target, value, root, path, errors);
  }

  // const
  if ('const' in schema && value !== schema.const) {
    errors.push({ path, msg: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    return;
  }

  // enum
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, msg: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` });
    return;
  }

  // type (single or array)
  if (schema.type) {
    const t = typeOf(value);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((x) => {
      if (x === 'integer') return t === 'number' && Number.isInteger(value);
      return x === t;
    });
    if (!ok) {
      errors.push({ path, msg: `expected type ${allowed.join('|')}, got ${t}` });
      return;
    }
  }

  // oneOf — exactly one branch matches
  if (schema.oneOf) {
    let matches = 0;
    let firstErr = null;
    for (const branch of schema.oneOf) {
      const local = [];
      validate(branch, value, root, path, local);
      if (local.length === 0) matches += 1;
      else if (!firstErr) firstErr = local[0];
    }
    if (matches !== 1) {
      errors.push({ path, msg: `oneOf: expected exactly one branch to match, got ${matches}${firstErr ? ' (first branch error: ' + firstErr.msg + ')' : ''}` });
      return;
    }
  }

  const t = typeOf(value);

  if (t === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, msg: `minLength ${schema.minLength} not met (got ${value.length})` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, msg: `pattern /${schema.pattern}/ not matched by ${JSON.stringify(value)}` });
    }
  }

  if (t === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, msg: `minimum ${schema.minimum} not met (got ${value})` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, msg: `maximum ${schema.maximum} exceeded (got ${value})` });
    }
  }

  if (t === 'array') {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, msg: `minItems ${schema.minItems} not met (got ${value.length})` });
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validate(schema.items, value[i], root, `${path}[${i}]`, errors);
      }
    }
  }

  if (t === 'object') {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in value)) errors.push({ path, msg: `missing required property "${k}"` });
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) validate(sub, value[k], root, path ? `${path}.${k}` : k, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(schema.properties || {}));
      for (const k of Object.keys(value)) {
        if (!declared.has(k)) {
          errors.push({ path, msg: `unknown property "${k}"` });
        }
      }
    }
  }
}

export function makeValidator(schema, defName) {
  const target = defName ? schema.definitions?.[defName] : schema;
  if (!target) throw new Error(`definition not found: ${defName}`);
  return function check(value) {
    const errors = [];
    validate(target, value, schema, '', errors);
    return { ok: errors.length === 0, errors };
  };
}
