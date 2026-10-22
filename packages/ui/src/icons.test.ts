import { describe, expect, it } from 'vitest';
import { iconPaths } from './icons.js';

describe('iconPaths', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'propertyIsEnumerable'])('returns null for prototype-inherited name "%s"', (name) => {
    expect(iconPaths(name)).toBeNull();
  });

  it.each(['heart', 'star'])('returns path data for "%s"', (name) => {
    const paths = iconPaths(name);
    expect(paths).not.toBeNull();
    expect(Array.isArray(paths)).toBe(true);
  });

  it('resolves an existing alias to its icon path data', () => {
    expect(iconPaths('health')).toEqual(iconPaths('heart'));
  });
});
