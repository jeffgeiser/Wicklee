import { describe, it, expect } from 'vitest';
import { hasClerkSessionHint } from '../clerkHint';

describe('hasClerkSessionHint', () => {
  it('is false with no cookies', () => {
    expect(hasClerkSessionHint('')).toBe(false);
  });
  it('is false when Clerk says signed out (__client_uat=0)', () => {
    expect(hasClerkSessionHint('__client_uat=0; other=1')).toBe(false);
  });
  it('is true with a non-zero __client_uat', () => {
    expect(hasClerkSessionHint('foo=bar; __client_uat=1758550000')).toBe(true);
  });
  it('is true with a __session JWT', () => {
    expect(hasClerkSessionHint('__session=eyJhbGciOi.abc.def')).toBe(true);
  });
  it('ignores an empty __session and unrelated look-alikes', () => {
    expect(hasClerkSessionHint('__session=')).toBe(false);
    expect(hasClerkSessionHint('my__session=abc; x__client_uat=5')).toBe(false);
  });
});
