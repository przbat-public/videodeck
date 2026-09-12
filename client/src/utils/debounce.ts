export interface DebouncedFunction<Args extends unknown[]> {
  (...args: Args): void;
  /** Drops a pending call; safe to call when nothing is scheduled */
  cancel: () => void;
}

/**
 * Trailing-edge debounce: `fn` runs once the caller has been quiet for `delay`
 * ms, always with the arguments of the most recent call.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number
): DebouncedFunction<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: Args) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delay);
  };

  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}
