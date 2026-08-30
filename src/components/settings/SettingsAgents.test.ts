// The Agents column's two load-bearing behaviours are that it opens on the
// agent the main page has selected, and that it will not let you edit a
// command line without asking for it first. Both are easy to break with a
// plausible-looking refactor, and neither shows up in a type error.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useConfigStore } from '../../stores/config';
import SettingsAgents from './SettingsAgents.vue';

const updateAgent = vi.fn();

vi.mock('../../lib/host', () => ({
  addAgent: vi.fn(),
  removeAgent: vi.fn(),
  updateAgent: (...args: unknown[]) => updateAgent(...args),
  // The store imports these at module load.
  getConfig: vi.fn(async () => ({ agents: {} })),
  reloadConfig: vi.fn(),
  getConfigPath: vi.fn(async () => ''),
  onConfigChanged: vi.fn(async () => () => {}),
}));

const CONFIG = {
  agents: {
    alpha: { transport: 'stdio' as const, command: 'npx', args: ['-y', '@a/alpha'] },
    beta: { transport: 'websocket' as const, url: 'wss://example.com/v1' },
  },
};

function render(initialAgent: string) {
  setActivePinia(createPinia());
  const store = useConfigStore();
  store.config = { ...CONFIG };
  return mount(SettingsAgents, { props: { initialAgent } });
}

beforeEach(() => {
  updateAgent.mockReset();
});

describe('SettingsAgents', () => {
  it('opens on the agent the main page has selected', () => {
    const wrapper = render('beta');
    expect(wrapper.find('select').element.value).toBe('beta');
    expect(wrapper.text()).toContain('wss://example.com/v1');
  });

  it('falls back to the first agent when the selected one is unknown', () => {
    const wrapper = render('gone');
    expect(wrapper.find('select').element.value).toBe('alpha');
  });

  it('shows the configuration read-only until Edit is pressed', async () => {
    const wrapper = render('alpha');
    // Only the agent picker is present; nothing is typeable.
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('npx');

    await wrapper.get('.st-actions button').trigger('click');
    const inputs = wrapper.findAll('input[type="text"]');
    expect(inputs.length).toBeGreaterThan(0);
    expect((inputs[0].element as HTMLInputElement).value).toBe('alpha');
  });

  it('returns to the read-only view on Cancel without writing anything', async () => {
    const wrapper = render('alpha');
    await wrapper.get('.st-actions button').trigger('click');
    const buttons = wrapper.findAll('.st-actions button');
    await buttons[buttons.length - 1].trigger('click'); // Cancel
    expect(wrapper.findAll('input[type="text"]')).toHaveLength(0);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not leak secret values into the read-only view', () => {
    setActivePinia(createPinia());
    const store = useConfigStore();
    store.config = {
      agents: {
        alpha: {
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: { API_KEY: 'sk-super-secret' },
        },
      },
    };
    const wrapper = mount(SettingsAgents, { props: { initialAgent: 'alpha' } });
    expect(wrapper.text()).toContain('API_KEY');
    expect(wrapper.text()).not.toContain('sk-super-secret');
  });
});
