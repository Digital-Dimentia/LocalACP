// Mounting a real SFC outside a Tauri host.
//
// This is the component half of what `schema-form.ts` describes: the module
// decides that a property is an enum, and this decides that an enum is a
// `<select>` carrying its labels. Neither is much use without the other, and a
// pure test of the module would happily pass while the form rendered nothing.

import { mount } from '@vue/test-utils';
import ToolParamForm from './ToolParamForm.vue';
import {
  initialValues,
  parseSchema,
  requiredKeys,
  validate,
  type FormValues,
} from '../../lib/schema-form';

const SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', title: 'Text', description: 'What to echo back.' },
    case: {
      type: 'string',
      title: 'Case',
      enum: ['upper', 'lower'],
      enumNames: ['UPPERCASE', 'lowercase'],
    },
    times: { type: 'integer', title: 'Times', minimum: 1, maximum: 10 },
    shout: { type: 'boolean', title: 'Shout' },
    kind: {
      type: 'array',
      title: 'Kinds',
      items: { type: 'string', enum: ['file', 'symbol'] },
    },
  },
};

function render(overrides: FormValues = {}) {
  const form = parseSchema(SCHEMA);
  if (!form) throw new Error('fixture schema should parse');
  const values = { ...initialValues(form), ...overrides };
  return mount(ToolParamForm, {
    props: {
      form,
      values,
      required: requiredKeys(form, values),
      errors: validate(form, values),
    },
  });
}

describe('ToolParamForm', () => {
  it('renders one field per property', () => {
    expect(render().findAll('.field')).toHaveLength(5);
  });

  it('marks required fields and only those', () => {
    const wrapper = render();
    const marked = wrapper
      .findAll('.field')
      .filter((field) => field.find('.req').exists())
      .map((field) => field.find('.field-name').text());
    expect(marked).toEqual(['Text']);
  });

  it('renders an enum as a select carrying its labels', () => {
    // The whole point of the feature: the legal values are on screen, so the
    // user picks one instead of spelling it.
    const options = render().find('select').findAll('option');
    expect(options.map((o) => o.text())).toEqual(['— not sent —', 'UPPERCASE', 'lowercase']);
  });

  it('offers no blank option for a required enum', () => {
    const form = parseSchema({
      type: 'object',
      required: ['case'],
      properties: { case: { type: 'string', enum: ['upper', 'lower'] } },
    })!;
    const wrapper = mount(ToolParamForm, {
      props: { form, values: initialValues(form), required: new Set(['case']), errors: {} },
    });
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual(['upper', 'lower']);
  });

  it('carries numeric bounds onto the input', () => {
    const input = render().find('input[type="number"]');
    expect(input.attributes('min')).toBe('1');
    expect(input.attributes('max')).toBe('10');
  });

  it('shows an untouched boolean as not sent', () => {
    expect(render().find('.check-state').text()).toBe('not sent');
  });

  it('emits the whole value map when a field changes', () => {
    const wrapper = render();
    wrapper.find('input[type="text"]').setValue('hello');
    const emitted = wrapper.emitted('update:values');
    expect(emitted).toHaveLength(1);
    // The whole map, not a patch: the store writes values and the assembled
    // line together, and a partial update would leave them disagreeing.
    expect(emitted![0][0]).toMatchObject({ text: 'hello', shout: undefined });
  });

  it('adds and removes rows of a list', () => {
    const wrapper = render({ kind: ['file'] });
    expect(wrapper.findAll('.list-row')).toHaveLength(1);

    wrapper.find('.add').trigger('click');
    expect(wrapper.emitted('update:values')![0][0]).toMatchObject({ kind: ['file', ''] });

    wrapper.findAll('.list-row')[0].find('.ghost-btn').trigger('click');
    expect(wrapper.emitted('update:values')![1][0]).toMatchObject({ kind: [] });
  });

  it('shows a validation error in place of the description', () => {
    const wrapper = render({ times: '99' });
    const field = wrapper
      .findAll('.field')
      .find((f) => f.find('.field-name').text() === 'Times')!;
    expect(field.find('.field-error').text()).toBe('Maximum is 10.');
  });

  it('disables every control when the row cannot run', () => {
    const form = parseSchema(SCHEMA)!;
    const wrapper = mount(ToolParamForm, {
      props: {
        form,
        values: initialValues(form),
        required: new Set(['text']),
        errors: {},
        disabled: true,
      },
    });
    expect(wrapper.findAll('.control').every((c) => c.attributes('disabled') !== undefined)).toBe(
      true
    );
  });
});
