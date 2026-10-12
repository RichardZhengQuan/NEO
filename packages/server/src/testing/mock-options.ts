import type { MockScript } from '@neo/providers';
import type { CreateServicesOptions } from '../index.js';
import { scriptedMockScript } from '../../../providers/src/testing/scripted-brain.js';

/** The scripted fixture keeps real runtime, tools and memory integration tests offline. */
export function scriptedProviderOptions(mockScript: MockScript = scriptedMockScript): CreateServicesOptions {
  return {
    mockProviders: [{ id: 'test', kind: 'mock', label: 'Test provider', enabled: true, defaultModel: 'neo-test' }],
    mockScript,
  };
}
