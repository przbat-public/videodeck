import 'i18next';
import type pl from './locales/pl.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: { common: typeof pl };
  }
}
