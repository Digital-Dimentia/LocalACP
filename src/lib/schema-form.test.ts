// The schema-to-form-to-command-line pipeline.
//
// Two different kinds of test live here, and the split matters.
//
// The `toInvocationLine` cases come from fixtures/invocation-lines.json, which
// python-acp's test suite reads too. That contract crosses a language
// boundary — this side writes the line, `parse_command` and
// `coerce_arguments` read it — so the expectation is written down once, in a
// file, and each side is checked against it rather than against the other's
// behaviour.
//
// Everything else is ordinary unit testing of this module's own decisions.

import fixture from '../../fixtures/invocation-lines.json';
import {
  hasValue,
  initialValues,
  parseSchema,
  requiredKeys,
  shellQuote,
  toInvocationLine,
  unsupportedConstructs,
  validate,
  type FormValues,
} from './schema-form';

/** `parseSchema` with the null case asserted away, for schemas known good. */
function form(schema: unknown) {
  const parsed = parseSchema(schema);
  if (!parsed) throw new Error('expected the schema to parse');
  return parsed;
}

describe('toInvocationLine (shared round-trip fixture)', () => {
  // Guards against the file being emptied or renamed and the suite silently
  // asserting nothing.
  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(5);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const parsed = form(testCase.schema);
      // `null` in JSON is how the fixture spells an untouched checkbox, which
      // is `undefined` in the form's own representation.
      const values: FormValues = Object.fromEntries(
        Object.entries(testCase.values as Record<string, unknown>).map(([k, v]) => [
          k,
          v === null ? undefined : (v as FormValues[string]),
        ])
      );
      expect(toInvocationLine(testCase.command, parsed, values)).toBe(testCase.line);
    });
  }
});

describe('shellQuote', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('hello')).toBe('hello');
    expect(shellQuote('a/b-c_d.e')).toBe('a/b-c_d.e');
  });

  it('quotes anything with whitespace', () => {
    expect(shellQuote('two words')).toBe("'two words'");
  });

  it('closes, escapes and reopens an embedded single quote', () => {
    // POSIX single quotes have no escape of their own, so `'"'"'` is the only
    // way through — and it is what the far end's shlex expects.
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it('spells the empty string explicitly', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('parseSchema', () => {
  it('returns null for anything that is not a schema with properties', () => {
    for (const input of [undefined, null, 'string', 42, [], {}, { properties: 'no' }]) {
      expect(parseSchema(input)).toBeNull();
    }
  });

  it('survives a schema whose every field is the wrong type', () => {
    // Untrusted input from another process. Degrading to "no form" is fine;
    // throwing would cost the user the command itself.
    const parsed = parseSchema({
      type: 42,
      properties: { a: { type: ['string', 'null'], title: 7, enum: [] } },
      required: 'nope',
    });
    expect(parsed?.fields[0]).toMatchObject({ key: 'a', label: 'a', type: 'string' });
    expect(parsed?.fields[0].required).toBe(false);
  });

  it('puts required fields first, then keeps declaration order', () => {
    const parsed = form({
      type: 'object',
      required: ['b', 'd'],
      properties: { a: { type: 'string' }, b: {}, c: {}, d: {} },
    });
    expect(parsed.fields.map((f) => f.key)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('chooses a control for each declared type', () => {
    const parsed = form({
      type: 'object',
      properties: {
        s: { type: 'string' },
        long: { type: 'string', maxLength: 500 },
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        e: { type: 'string', enum: ['x'] },
        list: { type: 'array', items: { type: 'string' } },
        blobs: { type: 'array', items: { type: 'object' } },
        o: { type: 'object' },
        untyped: {},
      },
    });
    const controls = Object.fromEntries(parsed.fields.map((f) => [f.key, f.control]));
    expect(controls).toEqual({
      s: 'text',
      long: 'textarea',
      n: 'number',
      i: 'number',
      b: 'checkbox',
      e: 'select',
      list: 'list',
      blobs: 'json',
      o: 'json',
      untyped: 'json',
    });
  });

  it('maps string formats onto native input types', () => {
    const parsed = form({
      type: 'object',
      properties: {
        d: { type: 'string', format: 'date' },
        m: { type: 'string', format: 'email' },
        u: { type: 'string', format: 'uri' },
        unknown: { type: 'string', format: 'colour' },
      },
    });
    const types = Object.fromEntries(parsed.fields.map((f) => [f.key, f.inputType]));
    expect(types).toEqual({ d: 'date', m: 'email', u: 'url', unknown: undefined });
  });
});

describe('enum labels', () => {
  it('reads a plain enum', () => {
    const [field] = form({
      type: 'object',
      properties: { c: { type: 'string', enum: ['a', 'b'] } },
    }).fields;
    expect(field.options).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ]);
  });

  it('reads enumNames as the labels', () => {
    const [field] = form({
      type: 'object',
      properties: { c: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] } },
    }).fields;
    expect(field.options).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ]);
  });

  it('reads a oneOf of consts as an enum rather than refusing it', () => {
    // This is the schema-blessed way to title each choice, and MCP servers use
    // it. Treating it as an unsupported union would throw away a dropdown the
    // schema was explicitly describing.
    const [field] = form({
      type: 'object',
      properties: {
        c: {
          type: 'string',
          oneOf: [
            { const: 'file', title: 'Files' },
            { const: 'symbol', title: 'Symbols' },
          ],
        },
      },
    }).fields;
    expect(field.control).toBe('select');
    expect(field.options).toEqual([
      { value: 'file', label: 'Files' },
      { value: 'symbol', label: 'Symbols' },
    ]);
  });

  it('gives a list of enums a dropdown per row', () => {
    const [field] = form({
      type: 'object',
      properties: { k: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
    }).fields;
    expect(field.control).toBe('list');
    expect(field.item?.options?.map((o) => o.value)).toEqual(['a', 'b']);
  });
});

describe('unsupportedConstructs', () => {
  it('names every conditional keyword it finds', () => {
    expect(
      unsupportedConstructs({ if: {}, then: {}, allOf: [], dependentSchemas: {} })
    ).toEqual(['if', 'then', 'allOf', 'dependentSchemas']);
  });

  it('finds nothing in a plain schema', () => {
    expect(unsupportedConstructs({ type: 'object', properties: {} })).toEqual([]);
  });

  it('makes parseSchema refuse the whole form, not half of it', () => {
    // A conditional schema rendered as its unconditional half produces a call
    // that looks validated and is not — the one outcome worth refusing over.
    const parsed = parseSchema({
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' }, host: { type: 'string' } },
      if: { properties: { target: { const: 'remote' } } },
      then: { required: ['host'] },
    });
    expect(parsed?.fields).toEqual([]);
    expect(parsed?.unsupported).toEqual(['if', 'then']);
  });
});

describe('initialValues', () => {
  it('seeds from the schema defaults, in each control representation', () => {
    const parsed = form({
      type: 'object',
      properties: {
        s: { type: 'string', default: 'hi' },
        i: { type: 'integer', default: 3 },
        b: { type: 'boolean', default: true },
        list: { type: 'array', items: { type: 'string' }, default: ['a'] },
        o: { type: 'object', default: { a: 1 } },
      },
    });
    expect(initialValues(parsed)).toEqual({
      s: 'hi',
      i: '3',
      b: true,
      list: ['a'],
      o: '{\n  "a": 1\n}',
    });
  });

  it('leaves an undefaulted boolean unset rather than false', () => {
    // Unset means "omit the flag", which is a different statement from
    // "send false".
    const parsed = form({ type: 'object', properties: { b: { type: 'boolean' } } });
    expect(initialValues(parsed).b).toBeUndefined();
    expect(hasValue(initialValues(parsed).b)).toBe(false);
  });
});

describe('requiredKeys', () => {
  const schema = {
    type: 'object',
    required: ['query'],
    dependentRequired: { filter: ['notes'] },
    properties: {
      query: { type: 'string' },
      filter: { type: 'object' },
      notes: { type: 'string' },
    },
  };

  it('is just the required array while the trigger is empty', () => {
    expect([...requiredKeys(form(schema), { query: 'a' })]).toEqual(['query']);
  });

  it('adds the dependent keys once the trigger has a value', () => {
    const keys = requiredKeys(form(schema), { query: 'a', filter: '{"x":1}' });
    expect([...keys].sort()).toEqual(['notes', 'query']);
  });
});

describe('validate', () => {
  const schema = {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 2, maxLength: 5 },
      times: { type: 'integer', minimum: 1, maximum: 10 },
      ratio: { type: 'number' },
      case: { type: 'string', enum: ['upper', 'lower'] },
      filter: { type: 'object' },
      kind: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      pat: { type: 'string', pattern: '^[^*].*' },
    },
  };

  const check = (values: FormValues) => validate(form(schema), values);

  it('reports nothing for a valid form', () => {
    expect(check({ text: 'abc', times: '3', case: 'upper' })).toEqual({});
  });

  it('reports a missing required field', () => {
    expect(check({ text: '' })).toEqual({ text: 'Required.' });
  });

  it('reports a value outside a numeric range', () => {
    expect(check({ text: 'abc', times: '99' })).toMatchObject({ times: 'Maximum is 10.' });
    expect(check({ text: 'abc', times: '0' })).toMatchObject({ times: 'Minimum is 1.' });
  });

  it('reports a non-integer in an integer field', () => {
    expect(check({ text: 'abc', times: '1.5' })).toMatchObject({
      times: 'Whole number expected.',
    });
    // The same value is fine where the schema said `number`.
    expect(check({ text: 'abc', ratio: '1.5' })).toEqual({});
  });

  it('reports a value that is not in the enum', () => {
    expect(check({ text: 'abc', case: 'sideways' })).toMatchObject({
      case: 'Not one of: upper, lower.',
    });
  });

  it('reports string length and pattern violations', () => {
    expect(check({ text: 'a' })).toMatchObject({ text: 'At least 2 characters.' });
    expect(check({ text: 'abcdef' })).toMatchObject({ text: 'At most 5 characters.' });
    expect(check({ text: 'abc', pat: '*bad' })).toMatchObject({
      pat: 'Does not match ^[^*].*.',
    });
  });

  it('reports JSON that will not parse', () => {
    expect(check({ text: 'abc', filter: '{oops' }).filter).toContain('Not valid JSON');
  });

  it('reports a list entry outside its enum', () => {
    expect(check({ text: 'abc', kind: ['a', 'zzz'] })).toMatchObject({
      kind: 'Not one of: a, b.',
    });
  });

  it('ignores an unparseable pattern rather than blocking on it', () => {
    // A broken pattern is the schema's problem. Refusing the value would stop
    // a call the agent would have accepted.
    const parsed = form({
      type: 'object',
      properties: { p: { type: 'string', pattern: '([' } },
    });
    expect(validate(parsed, { p: 'anything' })).toEqual({});
  });
});
