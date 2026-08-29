// Turning an MCP tool's JSON Schema into a form, and the form back into a
// command line.
//
// A tool-invocation row used to be one free-text box: the user had to know the
// flag names, the types and the legal enum values, and found out they were
// wrong only after a round trip to the agent. Every one of those facts is in
// the tool's `inputSchema`, which the agent now carries across in
// `AvailableCommand._meta` (see docs/agent-integration.md).
//
// Two things about this module are deliberate.
//
// It is *pure*: no Vue, no store, no DOM. The component below it renders what
// `parseSchema` describes and the store never learns that schemas exist. This
// is also the only part of the feature with a contract that crosses a language
// boundary, and pure code is the part that can be pinned by tests.
//
// And it produces a *command line*, not a JSON object. `toInvocationLine`'s
// output is parsed at the far end by python-acp's `parse_command` and
// `coerce_arguments`, so the quoting and the flag repetition here are not a
// house style — they are that parser's input format. Changing them breaks a
// program in another language that this file cannot see.

/**
 * The slice of JSON Schema this module reads.
 *
 * Not a general JSON Schema model: everything here arrives from an agent
 * process and may be any shape at all, so every field is optional and every
 * reader below re-checks the type it wants rather than trusting this
 * declaration.
 */
export interface JsonSchema {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  dependentRequired?: unknown;
  enum?: unknown;
  enumNames?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  allOf?: unknown;
  if?: unknown;
  dependentSchemas?: unknown;
  dependencies?: unknown;
  not?: unknown;
  default?: unknown;
  format?: unknown;
  items?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  multipleOf?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  [key: string]: unknown;
}

/** Which control renders a field. */
export type Control =
  | 'text'
  | 'textarea'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'list'
  | 'json';

/** One choice in a `select`, with the label to show for it. */
export interface EnumOption {
  /** The literal that goes on the command line. */
  value: string;
  /** What the user reads. Falls back to the value itself. */
  label: string;
}

/** Everything the form needs to render and validate one parameter. */
export interface FormField {
  key: string;
  label: string;
  control: Control;
  /** The schema's declared `type`, when it declared one. */
  type?: string;
  description?: string;
  /** Required by the schema's own `required` array, before dependencies. */
  required: boolean;
  options?: EnumOption[];
  /** Seed value, already in this field's value representation. */
  default?: FormValue;
  /** `<input type>` for text-ish controls, chosen from `format`. */
  inputType?: string;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** For `list`: how one row of it renders. */
  item?: FormField;
}

/**
 * A value as the form holds it, which is not the value as JSON sees it.
 *
 * Text, numbers and JSON blobs stay strings while they are being typed —
 * `"3."` is a legitimate thing to have in a number box mid-keystroke and is
 * not a number yet. Coercion happens once, at the far end, from the declared
 * type; doing it twice is how the form and the parser come to disagree.
 *
 * `undefined` on a checkbox means untouched, which is distinct from `false`:
 * an optional boolean nobody set is omitted rather than sent as `--flag false`.
 */
export type FormValue = string | boolean | string[] | undefined;

export type FormValues = Record<string, FormValue>;

/** A schema, parsed into everything the form and the serializer need. */
export interface SchemaForm {
  fields: FormField[];
  /** `dependentRequired`: key -> the keys it makes required once it has a value. */
  dependentRequired: Record<string, string[]>;
  /**
   * Conditional keywords found in the schema, by name. Non-empty means the
   * form cannot honestly represent this tool and the row falls back to the
   * raw line — see `parseSchema`.
   */
  unsupported: string[];
}

/** JSON Schema keywords whose meaning is "this schema changes shape". */
const CONDITIONAL_KEYWORDS = [
  'if',
  'then',
  'else',
  'allOf',
  'oneOf',
  'anyOf',
  'not',
  'dependentSchemas',
  'dependencies',
] as const;

/** `format` values that map onto a native input type. */
const INPUT_TYPES: Record<string, string> = {
  date: 'date',
  'date-time': 'datetime-local',
  time: 'time',
  email: 'email',
  uri: 'url',
  url: 'url',
  password: 'password',
};

/** Longer than this and a single-line box is the wrong shape. */
const TEXTAREA_THRESHOLD = 120;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The declared type, tolerating `type: ["string", "null"]`.
 *
 * The union form is how a schema says "optional" in some generators, and
 * reading only the first non-null member is what the far end's `coerce`
 * effectively does too.
 */
function declaredType(spec: Record<string, unknown>): string | undefined {
  const raw = spec.type;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const named = raw.find((t) => typeof t === 'string' && t !== 'null');
    return typeof named === 'string' ? named : undefined;
  }
  return undefined;
}

/** A scalar as it appears on the command line. */
function literal(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/**
 * The choices for a field, from any of the three ways a schema spells them.
 *
 * `enum` is the plain one. `enumNames` is the widespread convention for
 * labelling it. `oneOf`/`anyOf` made entirely of `const` entries is the
 * JSON-Schema-blessed way to attach a title to each choice, and MCP servers do
 * use it — treating that as an unsupported union would throw away a dropdown
 * the schema was explicitly describing.
 */
function enumOptions(spec: Record<string, unknown>): EnumOption[] | undefined {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    const names = Array.isArray(spec.enumNames) ? spec.enumNames : [];
    return spec.enum.map((value, index) => ({
      value: literal(value),
      label: asString(names[index]) ?? literal(value),
    }));
  }

  const branches = Array.isArray(spec.oneOf)
    ? spec.oneOf
    : Array.isArray(spec.anyOf)
      ? spec.anyOf
      : undefined;
  if (!branches || branches.length === 0) return undefined;
  const options: EnumOption[] = [];
  for (const branch of branches) {
    if (!isObject(branch) || !('const' in branch)) return undefined;
    options.push({
      value: literal(branch.const),
      label: asString(branch.title) ?? literal(branch.const),
    });
  }
  return options;
}

/** True for the item types a repeatable list can render a row for. */
function isScalarType(type: string | undefined): boolean {
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
}

/** Picks the control, which is the one decision the rest of the field follows from. */
function controlFor(
  spec: Record<string, unknown>,
  type: string | undefined,
  options: EnumOption[] | undefined
): Control {
  if (options) return 'select';
  if (type === 'boolean') return 'checkbox';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'array') {
    const items = isObject(spec.items) ? spec.items : undefined;
    if (!items) return 'json';
    const itemType = declaredType(items);
    return enumOptions(items) || isScalarType(itemType) ? 'list' : 'json';
  }
  if (type === 'object') return 'json';
  if (type === 'string') {
    const maxLength = asNumber(spec.maxLength);
    const long = maxLength !== undefined && maxLength > TEXTAREA_THRESHOLD;
    return long || spec.format === 'textarea' ? 'textarea' : 'text';
  }
  // No declared type. The far end reads an undeclared value as JSON and keeps
  // it as a string when that fails, so JSON is the honest box to offer — and
  // guessing `text` here would quietly make `3` a number for one property and
  // a string for the next.
  return 'json';
}

/** The seed value for a field, in that field's own representation. */
function defaultValue(control: Control, raw: unknown): FormValue {
  if (raw === undefined) {
    return control === 'checkbox' ? undefined : control === 'list' ? [] : '';
  }
  if (control === 'checkbox') return typeof raw === 'boolean' ? raw : undefined;
  if (control === 'list') {
    return Array.isArray(raw) ? raw.map(literal) : [];
  }
  if (control === 'json') {
    return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  }
  return literal(raw);
}

function buildField(
  key: string,
  spec: Record<string, unknown>,
  required: boolean
): FormField {
  const type = declaredType(spec);
  const options = enumOptions(spec);
  const control = controlFor(spec, type, options);

  const field: FormField = {
    key,
    label: asString(spec.title) ?? key,
    control,
    type,
    description: asString(spec.description),
    required,
    options,
    default: defaultValue(control, spec.default),
    min: asNumber(spec.minimum),
    max: asNumber(spec.maximum),
    step: type === 'integer' ? (asNumber(spec.multipleOf) ?? 1) : asNumber(spec.multipleOf),
    minLength: asNumber(spec.minLength),
    maxLength: asNumber(spec.maxLength),
    pattern: asString(spec.pattern),
  };

  const format = asString(spec.format);
  if (control === 'text' && format && INPUT_TYPES[format]) {
    field.inputType = INPUT_TYPES[format];
  }

  if (control === 'list' && isObject(spec.items)) {
    // One row of the list is a field in its own right, so a list of enums
    // gets a dropdown per row for free.
    field.item = buildField(key, spec.items, false);
  }

  return field;
}

/** Conditional keywords present at the root of a schema, by name. */
export function unsupportedConstructs(schema: unknown): string[] {
  if (!isObject(schema)) return [];
  const found = CONDITIONAL_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);
  // A `oneOf`/`anyOf` that is really an enum is handled as one, not refused —
  // but only at property level, where `enumOptions` sees it. At the root it
  // genuinely changes the shape of the whole object.
  return [...found];
}

/**
 * Read a schema into a form description, or return `null` if there is no form
 * to render.
 *
 * `null` covers a schema that is absent, malformed, has no properties, or uses
 * conditional keywords. All four mean the same thing to the caller — fall back
 * to the free-text line — and none of them is an error: a tool must never
 * become less reachable because its schema was odd.
 */
export function parseSchema(schema: unknown): SchemaForm | null {
  if (!isObject(schema)) return null;

  const unsupported = unsupportedConstructs(schema);
  if (unsupported.length > 0) {
    // Deliberately not a partial form. Rendering the unconditional half of a
    // conditional schema produces a call that looks validated and is not.
    return { fields: [], dependentRequired: {}, unsupported };
  }

  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (!properties) return null;

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
  );

  const fields: FormField[] = [];
  for (const key of Object.keys(properties)) {
    const spec = properties[key];
    if (!isObject(spec)) continue;
    fields.push(buildField(key, spec, required.has(key)));
  }
  if (fields.length === 0) return null;

  // Required first, then declaration order within each group — the shortest
  // call that works reads off the top of the form, which is the same promise
  // the agent's hint string makes.
  const ordered = [
    ...fields.filter((field) => field.required),
    ...fields.filter((field) => !field.required),
  ];

  const dependentRequired: Record<string, string[]> = {};
  if (isObject(schema.dependentRequired)) {
    for (const [key, value] of Object.entries(schema.dependentRequired)) {
      if (!Array.isArray(value)) continue;
      dependentRequired[key] = value.filter((n): n is string => typeof n === 'string');
    }
  }

  return { fields: ordered, dependentRequired, unsupported: [] };
}

/** Seed values for a fresh form. */
export function initialValues(form: SchemaForm): FormValues {
  const values: FormValues = {};
  for (const field of form.fields) values[field.key] = field.default;
  return values;
}

/** True when a value will actually be sent, rather than omitted. */
export function hasValue(value: FormValue): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some((entry) => entry.length > 0);
  return true;
}

/**
 * Which keys are required right now, `dependentRequired` included.
 *
 * Separate from `FormField.required` because this answer changes as the user
 * types: filling in one field can make another mandatory, and the asterisk has
 * to move with it.
 */
export function requiredKeys(form: SchemaForm, values: FormValues): Set<string> {
  const keys = new Set(form.fields.filter((f) => f.required).map((f) => f.key));
  for (const [trigger, dependents] of Object.entries(form.dependentRequired)) {
    if (!hasValue(values[trigger])) continue;
    for (const key of dependents) keys.add(key);
  }
  return keys;
}

/**
 * What is wrong with the form, per field.
 *
 * These mirror the errors python-acp's `coerce_arguments` raises, so the user
 * sees them before a round trip rather than after. That is all they are: the
 * agent still validates everything on arrival, and a form with no errors here
 * has been made convenient, not trusted.
 */
export function validate(form: SchemaForm, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = requiredKeys(form, values);

  for (const field of form.fields) {
    const value = values[field.key];
    const present = hasValue(value);

    if (!present) {
      if (required.has(field.key)) errors[field.key] = 'Required.';
      continue;
    }

    if (field.control === 'checkbox') continue;

    if (field.control === 'list') {
      const entries = Array.isArray(value) ? value : [];
      const item = field.item;
      for (const entry of entries) {
        if (entry.length === 0) continue;
        const problem = item ? scalarProblem(item, entry) : undefined;
        if (problem) {
          errors[field.key] = problem;
          break;
        }
      }
      continue;
    }

    if (field.control === 'json') {
      try {
        JSON.parse(String(value));
      } catch {
        errors[field.key] = `Not valid JSON. ${jsonExample(field)}`;
      }
      continue;
    }

    const problem = scalarProblem(field, String(value));
    if (problem) errors[field.key] = problem;
  }

  return errors;
}

/** What a single scalar entry gets wrong, if anything. */
function scalarProblem(field: FormField, text: string): string | undefined {
  if (field.options && !field.options.some((option) => option.value === text)) {
    return `Not one of: ${field.options.map((o) => o.value).join(', ')}.`;
  }

  if (field.control === 'number' || field.type === 'number' || field.type === 'integer') {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return `${field.type ?? 'number'} expected.`;
    if (field.type === 'integer' && !Number.isInteger(parsed)) {
      return 'Whole number expected.';
    }
    if (field.min !== undefined && parsed < field.min) return `Minimum is ${field.min}.`;
    if (field.max !== undefined && parsed > field.max) return `Maximum is ${field.max}.`;
    return undefined;
  }

  if (field.minLength !== undefined && text.length < field.minLength) {
    return `At least ${field.minLength} characters.`;
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return `At most ${field.maxLength} characters.`;
  }
  if (field.pattern) {
    let matches = true;
    try {
      matches = new RegExp(field.pattern).test(text);
    } catch {
      // An unparseable pattern is the schema's problem, not the user's, and
      // must not block a value the agent would have accepted.
      return undefined;
    }
    if (!matches) return `Does not match ${field.pattern}.`;
  }
  return undefined;
}

function jsonExample(field: FormField): string {
  return field.type === 'array' ? 'Example: ["one", "two"]' : 'Example: {"a": 1}';
}

/**
 * Quote a value the way Python's `shlex.quote` does.
 *
 * The far end splits the line with `shlex`, so this is not a choice of style:
 * anything outside the safe set has to be single-quoted, and an embedded
 * single quote has to be closed, escaped and reopened — `'"'"'` — because
 * POSIX single quotes have no escape of their own.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Assemble the command line the row will send.
 *
 * The output is python-acp's input format (`parse_command` then
 * `coerce_arguments`), so each rule below answers to that parser:
 *
 * - a repeated `--key` is how an array is spelled, and the parser collects
 *   them into a list;
 * - booleans are written out in full rather than as a bare `--flag`, which the
 *   parser also accepts — being explicit costs one word and removes the one
 *   case where a missing value means something;
 * - objects and complex arrays go as quoted JSON, which is the only form the
 *   parser will take for them;
 * - an optional field nobody filled in is not emitted at all, because sending
 *   an empty string is a different statement from staying silent.
 */
export function toInvocationLine(
  command: string,
  form: SchemaForm,
  values: FormValues
): string {
  const parts: string[] = [`/${command}`];

  for (const field of form.fields) {
    const value = values[field.key];
    if (!hasValue(value)) continue;
    const flag = `--${field.key}`;

    if (field.control === 'checkbox') {
      parts.push(flag, String(value === true));
      continue;
    }

    if (field.control === 'list') {
      for (const entry of value as string[]) {
        if (entry.length === 0) continue;
        parts.push(flag, shellQuote(entry));
      }
      continue;
    }

    if (field.control === 'json') {
      // Re-serialized rather than passed through, so the line carries no
      // stray newlines from the textarea the user typed it into.
      let compact = String(value);
      try {
        compact = JSON.stringify(JSON.parse(compact));
      } catch {
        // Left as typed; `validate` has already flagged it and Run is blocked.
      }
      parts.push(flag, shellQuote(compact));
      continue;
    }

    parts.push(flag, shellQuote(String(value)));
  }

  return parts.join(' ');
}
