import { afterEach, describe, expect, it } from 'vitest';
import { originOf, setRemoteImages, usePreferences } from './preferences.js';

describe('device preferences', () => {
  afterEach(() => setRemoteImages(false));

  it('keeps remote images off by default and stores the choice locally', () => {
    expect(usePreferences.getState().remoteImages).toBe(false);
    setRemoteImages(true);
    expect(usePreferences.getState().remoteImages).toBe(true);
    expect(localStorage.getItem('neo.remote-images')).toBe('on');
    setRemoteImages(false);
    expect(localStorage.getItem('neo.remote-images')).toBeNull();
  });

  it('derives the trusted server origin', () => {
    expect(originOf('https://neo.example/neo/')).toBe('https://neo.example');
    expect(originOf('http://192.168.1.4:7790')).toBe('http://192.168.1.4:7790');
    expect(originOf('neo://pair')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf(null)).toBeNull();
  });
});
