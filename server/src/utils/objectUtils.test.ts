import { stripUndefined } from './objectUtils';

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
