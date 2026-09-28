import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Deal Hunter',
    description: 'Paints Facebook Marketplace tiles MATCH, SKIP, or REVIEW against your brief.',
    action: {},
    permissions: ['storage'],
    host_permissions: ['https://openrouter.ai/*'],
  },
});
