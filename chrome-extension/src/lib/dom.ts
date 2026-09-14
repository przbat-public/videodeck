/**
 * getElementById that throws when the element is missing. The popup and
 * options pages are static HTML, so a missing element is a bug, not a state
 * to render around.
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}
