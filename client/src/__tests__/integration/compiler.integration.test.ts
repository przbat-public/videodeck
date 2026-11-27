import { describe, expect, it } from 'vitest';
import { Button } from '../../components/ui/Button';

/**
 * The bundle users get runs every component through React Compiler
 * (vite.config.ts), so the suite that renders the real <App /> has to load
 * the compiled components too: a rules-of-React break that only bites once
 * the compiler memoizes a component would otherwise pass here and fail in
 * the browser. A compiled component reads its memo cache slots (`$[0]`, from
 * react/compiler-runtime), which hand-written source never does, so the text
 * of one shared primitive tells which build this run loaded.
 */
describe('client integration build', () => {
  it('renders the components React Compiler compiled, as the shipped bundle does', () => {
    expect(String(Button)).toMatch(/\$\[0\]/);
  });
});
