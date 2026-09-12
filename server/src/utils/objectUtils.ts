/** Keys of T declared optional (`key?: …`) */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/** T with `undefined` additionally allowed on its optional properties */
export type WithUndefinedOptionals<T> = {
  [K in keyof T]: K extends OptionalKeys<T> ? T[K] | undefined : T[K];
};

/**
 * Copy of `value` without the properties whose value is `undefined`.
 *
 * Under `exactOptionalPropertyTypes` an optional property may be absent but
 * not explicitly `undefined`. When an object is assembled from sources that
 * may lack fields (info.json, request bodies) this turns
 * `{ videoId: undefined }` into `{}` while keeping the target type.
 */
export function stripUndefined<T extends object>(value: WithUndefinedOptionals<T>): T {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as T;
}
