import { describe, it, expect } from 'vitest';
import { safeRedirectPath } from '../authRedirect';

const q = (v: string) => `?redirect_url=${encodeURIComponent(v)}`;
const ORIGIN = 'https://wicklee.dev';
const safe = (search: string) => safeRedirectPath(search, ORIGIN);

describe('safeRedirectPath', () => {
  it('returns a same-origin path with its query intact', () => {
    expect(safe(q('/pricing?plan=team_10&cycle=annual&checkout=1')))
      .toBe('/pricing?plan=team_10&cycle=annual&checkout=1');
  });

  it('is null when absent or empty', () => {
    expect(safe('')).toBeNull();
    expect(safe('?redirect_url=')).toBeNull();
  });

  it('rejects anything that could leave the origin', () => {
    expect(safe(q('https://evil.example/'))).toBeNull();
    expect(safe(q('//evil.example/'))).toBeNull();
    expect(safe(q('/\\evil.example/'))).toBeNull();
    expect(safe(q('javascript:alert(1)'))).toBeNull();
    // Browsers strip tab/newline and treat backslash as slash.
    expect(safe(q('/\t/evil.example/'))).toBeNull();
    expect(safe(q('/\n/evil.example/'))).toBeNull();
    expect(safe(q('\\evil.example/'))).toBeNull();
  });
});
