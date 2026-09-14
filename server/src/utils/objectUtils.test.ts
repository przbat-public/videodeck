import { errnoCode, isRecord, readString, stripUndefined } from './objectUtils';

interface Sample {
  id: string;
  name?: string;
  count?: number;
  nested?: { value: string };
}

describe('stripUndefined', () => {
  it('drops keys whose value is undefined', () => {
    const result = stripUndefined<Sample>({
      id: 'a',
      name: undefined,
      count: 0,
      nested: undefined,
    });

    expect(result).toEqual({ id: 'a', count: 0 });
    expect('name' in result).toBe(false);
    expect('nested' in result).toBe(false);
  });

  it('keeps falsy values that are not undefined', () => {
    const result = stripUndefined<Sample>({ id: '', name: '', count: 0 });

    expect(result).toEqual({ id: '', name: '', count: 0 });
  });

  it('keeps present optional values and returns a new object', () => {
    const nested = { value: 'x' };
    const input = { id: 'a', name: 'n', count: 1, nested };
    const result = stripUndefined<Sample>(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.nested).toBe(nested);
  });

  it('accepts an object without any optional keys', () => {
    expect(stripUndefined<Sample>({ id: 'only' })).toEqual({ id: 'only' });
  });
});

describe('isRecord', () => {
  it('accepts plain objects and rejects arrays, null and primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('readString', () => {
  it('returns non-empty strings and undefined otherwise', () => {
    expect(readString('abc')).toBe('abc');
    expect(readString('')).toBeUndefined();
    expect(readString(['a'])).toBeUndefined();
    expect(readString(42)).toBeUndefined();
    expect(readString(undefined)).toBeUndefined();
  });
});

describe('errnoCode', () => {
  it('reads the code of a Node.js error and returns undefined otherwise', () => {
    expect(errnoCode(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode(new Error('plain'))).toBeUndefined();
    expect(errnoCode({ code: 42 })).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
  });
});
