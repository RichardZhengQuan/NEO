/**
 * Shared types and Hono context variable map augmentation.
 */
import type { Device } from '@neo/protocol';

// Extend Hono's ContextVariableMap so c.get('device') / c.set('device', …) are typed.
declare module 'hono' {
  interface ContextVariableMap {
    device: Device;
  }
}

export type {};
