// Shared vitest config: resolve workspace packages from their TypeScript sources
// via the "neo-source" export condition, so tests never need a prior build.
import { defineConfig } from 'vitest/config';

export const sourceConditions = ['neo-source', 'module', 'node', 'import', 'default'];

export default defineConfig({
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions, externalConditions: ['neo-source'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20_000,
  },
});
