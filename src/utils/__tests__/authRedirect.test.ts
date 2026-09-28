import { describe, it, expect } from 'vitest';
import { safeRedirectPath } from '../authRedirect';

const q = (v: string) => `?redirect_url=${encodeURIComponent(v)}`;

describe('safeRedirectPath', () => {
  it('returns a same-origin path with its query intact', () => {
    expect(safeRedirectPath(q('/pricing?plan=team_10&cycle=annual&checkout=1')))
      .toBe('/pricing?plan=team_10&cycle=annual&checkout=1');
  });

  it('is null when absent or empty', () => {
    expect(safeRedirectPath('')).toBeNull();
    expect(safeRedirectPath('?redirect_url=')).toBeNull();
  });

  it('rejects anything that could leave the origin', () => {
    expect(safeRedirectPath(q('https://evil.example/'))).toBeNull();
    expect(safeRedirectPath(q('//evil.example/'))).toBeNull();
    expect(safeRedirectPath(q('/\\evil.example/'))).toBeNull();
    expect(safeRedirectPath(q('javascript:alert(1)'))).toBeNull();
  });
});
