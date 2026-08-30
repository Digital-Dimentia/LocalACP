// This replaced native `title` tooltips precisely because those are hover-only.
// If it regresses to something that cannot be opened and closed from the
// keyboard, the copy it hides — including what telemetry sends and that debug
// logs can contain prompt text — becomes unreachable for some users.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import InfoPopover from './InfoPopover.vue';

function render() {
  return mount(InfoPopover, {
    props: { label: 'Privacy' },
    slots: { default: 'What gets sent.' },
    attachTo: document.body,
  });
}

describe('InfoPopover', () => {
  it('starts closed and names itself for screen readers', () => {
    const wrapper = render();
    const trigger = wrapper.get('.info-trigger');
    expect(trigger.attributes('aria-label')).toBe('About Privacy');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.info-bubble').exists()).toBe(false);
    wrapper.unmount();
  });

  it('toggles on click', async () => {
    const wrapper = render();
    await wrapper.get('.info-trigger').trigger('click');
    expect(wrapper.get('.info-bubble').text()).toBe('What gets sent.');
    expect(wrapper.get('.info-trigger').attributes('aria-expanded')).toBe('true');

    await wrapper.get('.info-trigger').trigger('click');
    expect(wrapper.find('.info-bubble').exists()).toBe(false);
    wrapper.unmount();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const wrapper = render();
    await wrapper.get('.info-trigger').trigger('click');
    // The document listener is registered on the tick after opening.
    await wrapper.vm.$nextTick();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.info-bubble').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.info-trigger').element);
    wrapper.unmount();
  });

  it('stops listening to the document once unmounted', async () => {
    const wrapper = render();
    await wrapper.get('.info-trigger').trigger('click');
    await wrapper.vm.$nextTick();
    wrapper.unmount();
    // Would throw against a detached component if the listener survived.
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    ).not.toThrow();
  });
});
