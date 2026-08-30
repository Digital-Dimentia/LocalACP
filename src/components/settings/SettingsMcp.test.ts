// The MCP column packs two actions into one row: a toggle that writes
// immediately and a row body that only selects. Confusing them either parks a
// server when you meant to read it, or silently does nothing when you meant to
// disable it — so both halves are pinned here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useConfigStore } from '../../stores/config';
import SettingsMcp from './SettingsMcp.vue';

const updateMcpServer = vi.fn(async () => ({ agents: {}, mcpServers: {} }));

vi.mock('../../lib/host', () => ({
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  updateMcpServer: (...args: unknown[]) => updateMcpServer(...(args as [])),
  getConfig: vi.fn(async () => ({ agents: {} })),
  reloadConfig: vi.fn(),
  getConfigPath: vi.fn(async () => ''),
  onConfigChanged: vi.fn(async () => () => {}),
}));

function render() {
  setActivePinia(createPinia());
  const store = useConfigStore();
  store.config = {
    agents: {},
    mcpServers: {
      files: {
        transport: 'stdio',
        command: '/usr/bin/python3',
        args: ['/srv/files.py'],
        env: { TOKEN: 'tok-secret' },
        description: 'Local files',
      },
      remote: { transport: 'http', url: 'https://mcp.example.com/v1', enabled: false },
    },
  };
  return mount(SettingsMcp);
}

beforeEach(() => {
  updateMcpServer.mockClear();
});

describe('SettingsMcp', () => {
  it('lists every server, including disabled ones', () => {
    const wrapper = render();
    const names = wrapper.findAll('.mcp-row-name').map((b) => b.text());
    expect(names).toEqual(['files', 'remote']);
  });

  it('reflects enabled state, treating an absent field as enabled', () => {
    const wrapper = render();
    const boxes = wrapper.findAll('.mcp-toggle input');
    expect((boxes[0].element as HTMLInputElement).checked).toBe(true);
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false);
  });

  it('writes the flipped enabled state from the toggle without selecting the row', async () => {
    const wrapper = render();
    await wrapper.findAll('.mcp-toggle input')[0].trigger('change');
    expect(updateMcpServer).toHaveBeenCalledWith(
      'files',
      expect.objectContaining({ enabled: false })
    );
    // Still nothing selected, so no config panel opened.
    expect(wrapper.find('.mcp-detail').exists()).toBe(false);
  });

  it('shows the configuration read-only when a row body is clicked', async () => {
    const wrapper = render();
    expect(wrapper.find('.mcp-detail').exists()).toBe(false);

    await wrapper.findAll('.mcp-row-name')[0].trigger('click');
    const detail = wrapper.get('.mcp-detail');
    expect(detail.text()).toContain('/usr/bin/python3');
    expect(detail.findAll('input[type="text"]')).toHaveLength(0);
    // Selecting must not have written anything.
    expect(updateMcpServer).not.toHaveBeenCalled();
  });

  it('opens the editable form only after Edit', async () => {
    const wrapper = render();
    await wrapper.findAll('.mcp-row-name')[0].trigger('click');
    await wrapper.get('.mcp-detail .st-actions button').trigger('click');
    const inputs = wrapper.findAll('.mcp-detail input[type="text"]');
    expect(inputs.length).toBeGreaterThan(0);
    expect((inputs[0].element as HTMLInputElement).value).toBe('files');
  });

  it('does not leak secret values into the read-only view', async () => {
    const wrapper = render();
    await wrapper.findAll('.mcp-row-name')[0].trigger('click');
    const detail = wrapper.get('.mcp-detail');
    expect(detail.text()).toContain('TOKEN');
    expect(detail.text()).not.toContain('tok-secret');
  });
});
