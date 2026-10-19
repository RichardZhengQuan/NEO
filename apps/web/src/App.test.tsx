import { describe, it, expect } from 'vitest';
import { buildPairNeoUrl } from './App.js';
import type { Route } from './router.js';

type PairRoute = Extract<Route, { name: 'pair' }>;

const RELAY = 'wss://relay.example.com/ws';
const TOKEN = 'tok_abc123';

describe('buildPairNeoUrl', () => {
  it('tunnel-only link on Android Capacitor does not inject https://localhost as server', () => {
    const route: PairRoute = { name: 'pair', token: TOKEN, relay: RELAY };
    // Simulate Android Capacitor WebView (androidScheme: 'https')
    const url = buildPairNeoUrl(route, 'https://localhost', 'https:');
    expect(url).not.toContain('localhost');
    expect(url).not.toContain('server=');
    expect(url).toContain(`relay=${encodeURIComponent(RELAY)}`);
    expect(url).toContain(`token=${TOKEN}`);
  });

  it('tunnel-only link on Android Capacitor (capacitor:// scheme) does not inject server', () => {
    const route: PairRoute = { name: 'pair', token: TOKEN, relay: RELAY };
    const url = buildPairNeoUrl(route, 'capacitor://localhost', 'capacitor:');
    expect(url).not.toContain('localhost');
    expect(url).not.toContain('server=');
  });

  it('browser with real HTTPS origin injects the origin as server', () => {
    const route: PairRoute = { name: 'pair', token: TOKEN, relay: RELAY };
    const url = buildPairNeoUrl(route, 'https://neo.example.com', 'https:');
    expect(url).toContain('server=https%3A%2F%2Fneo.example.com');
  });

  it('explicit serverUrl in route is always used', () => {
    const route: PairRoute = { name: 'pair', token: TOKEN, serverUrl: 'https://home.example.com' };
    const url = buildPairNeoUrl(route, 'https://localhost', 'https:');
    expect(url).toContain('server=https%3A%2F%2Fhome.example.com');
    expect(url).not.toContain('localhost');
  });

  it('file:// / Electron origin does not inject server', () => {
    const route: PairRoute = { name: 'pair', token: TOKEN };
    const url = buildPairNeoUrl(route, 'null', 'file:');
    expect(url).not.toContain('server=');
  });
});
