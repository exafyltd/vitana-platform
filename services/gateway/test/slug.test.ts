import { isValidSlug, toSlug } from '../src/lib/slug';

describe('isValidSlug', () => {
  it('returns true for an already-valid slug', () => {
    expect(isValidSlug('my-slug')).toBe(true);
    expect(isValidSlug('abc')).toBe(true);
    expect(isValidSlug('abc123')).toBe(true);
    expect(isValidSlug('a1-b2-c3')).toBe(true);
  });

  it('returns false for the empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('returns false for uppercase letters', () => {
    expect(isValidSlug('My-Slug')).toBe(false);
    expect(isValidSlug('ABC')).toBe(false);
  });

  it('returns false for spaces', () => {
    expect(isValidSlug('my slug')).toBe(false);
    expect(isValidSlug(' my-slug')).toBe(false);
  });

  it('returns false for leading, trailing, or consecutive hyphens', () => {
    expect(isValidSlug('-my-slug')).toBe(false);
    expect(isValidSlug('my-slug-')).toBe(false);
    expect(isValidSlug('my--slug')).toBe(false);
    expect(isValidSlug('-')).toBe(false);
  });

  it('returns false for strings longer than 64 characters', () => {
    expect(isValidSlug('a'.repeat(65))).toBe(false);
    expect(isValidSlug('a'.repeat(100))).toBe(false);
  });

  it('returns true for a string of exactly 64 characters', () => {
    expect(isValidSlug('a'.repeat(64))).toBe(true);
  });

  it('returns false for strings containing non-slug characters', () => {
    expect(isValidSlug('my_slug')).toBe(false);
    expect(isValidSlug('my.slug')).toBe(false);
    expect(isValidSlug('my/slug')).toBe(false);
  });
});

describe('toSlug', () => {
  it('lowercases mixed-case input', () => {
    expect(toSlug('Hello World')).toBe('hello-world');
    expect(toSlug('MiXeD CaSe')).toBe('mixed-case');
  });

  it('collapses multiple consecutive spaces into a single hyphen', () => {
    expect(toSlug('hello    world')).toBe('hello-world');
    expect(toSlug('a  b  c')).toBe('a-b-c');
  });

  it('trims leading and trailing spaces', () => {
    expect(toSlug('  hello world  ')).toBe('hello-world');
    expect(toSlug('   hello   ')).toBe('hello');
  });

  it('collapses consecutive hyphens in the input into one hyphen', () => {
    expect(toSlug('hello---world')).toBe('hello-world');
    expect(toSlug('a--b----c')).toBe('a-b-c');
  });

  it('converts runs of whitespace and underscores to a single hyphen', () => {
    expect(toSlug('hello __ world')).toBe('hello-world');
    expect(toSlug('a_b__c___d')).toBe('a-b-c-d');
  });

  it('strips leading and trailing hyphens from the result', () => {
    expect(toSlug('  --hello--  ')).toBe('hello');
    expect(toSlug('-hello-world-')).toBe('hello-world');
  });

  it('removes characters that are not [a-z0-9-]', () => {
    expect(toSlug('hello, world!')).toBe('hello-world');
    expect(toSlug('café déjà vu')).toBe('caf-d-j-vu');
  });

  it('returns "item" for punctuation / emoji / whitespace-only input', () => {
    expect(toSlug('!!!@@@###')).toBe('item');
    expect(toSlug('   ')).toBe('item');
    expect(toSlug('___')).toBe('item');
    expect(toSlug('🎉🎉🎉')).toBe('item');
    expect(toSlug('')).toBe('item');
  });

  it('does not truncate long inputs', () => {
    const long = 'a'.repeat(100);
    expect(toSlug(long)).toBe(long);
    expect(toSlug(long)).toHaveLength(100);
  });
});

describe('toSlug / isValidSlug round-trip', () => {
  it('isValidSlug(toSlug(x)) is true for representative inputs', () => {
    const inputs = [
      'Hello World',
      '  Trim Me  ',
      'Under_score Here',
      'MixedCASE123',
      'a--b--c',
      '!!!',
      '🎉 hi 🎉',
      'a'.repeat(64),
    ];

    for (const input of inputs) {
      const slug = toSlug(input);
      expect(isValidSlug(slug)).toBe(true);
    }
  });
});