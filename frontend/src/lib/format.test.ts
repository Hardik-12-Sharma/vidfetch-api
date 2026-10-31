import { describe, expect, it } from 'vitest';
import { fmtSize } from './format';

describe('fmtSize', () => {
  it('formats bytes like the original', () => {
    expect(fmtSize(0)).toBe(''); expect(fmtSize(undefined)).toBe(''); expect(fmtSize(-5)).toBe('');
    expect(fmtSize(10)).toBe('1 KB'); expect(fmtSize(2048)).toBe('2 KB');
    expect(fmtSize(5 * 1024 * 1024)).toBe('5.0 MB'); expect(fmtSize(250 * 1024 * 1024)).toBe('250 MB');
    expect(fmtSize(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});
