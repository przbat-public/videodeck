import { useEffect, useState } from 'react';

/**
 * The debounced copy of `value`: it updates only after `delay` ms without a
 * change. SearchBar used to hand-roll this effect twice (query phrase and
 * channel filter); the hook keeps one implementation.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}
