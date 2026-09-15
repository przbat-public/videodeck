import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';

export const MAX_HEIGHT_CHOICES = [720, 1080, 1440, 2160];

/** `-N` values offered by the editor (yt-dlp caps fragments at 16) */
export const FRAGMENT_CHOICES = [1, 2, 4, 8, 16];

/** "en, pl" → ['en', 'pl'] */
export const parseSubLangs = (value: string): string[] =>
  value
    .split(/[,\s]+/)
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0);

/**
 * "--cookies-from-browser chrome --proxy http://p" →
 * ['--cookies-from-browser', 'chrome', '--proxy', 'http://p'].
 * Simple whitespace split on purpose: flags are passed to yt-dlp as separate
 * argv entries (no shell), so quoting inside one entry is not supported.
 */
export const parseExtraArgs = (value: string): string[] =>
  value
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);

/**
 * Distinct categories already used across the folders, sorted — offered as
 * suggestions so the same topic does not end up spelled three ways.
 */
export const collectCategories = (configs: Record<string, FolderConfig | null>): string[] => {
  const byLowercase = new Map<string, string>();
  for (const config of Object.values(configs)) {
    const category = config?.category?.trim();
    if (category && !byLowercase.has(category.toLowerCase())) {
      byLowercase.set(category.toLowerCase(), category);
    }
  }
  return [...byLowercase.values()].sort((a, b) => a.localeCompare(b));
};

export interface FormState {
  channelUrl: string;
  /** '' removes the category from config.json */
  category: string;
  /** '' means "use default" */
  maxHeight: string;
  subtitlesEnabled: boolean;
  /** comma separated; empty with subtitles enabled means "use default" */
  subLangs: string;
  writeComments: boolean;
  /** whitespace separated yt-dlp flags; '' means "use default" */
  extraArgs: string;
  /** --impersonate chrome */
  impersonate: boolean;
  /** --sponsorblock-remove sponsor,selfpromo,interaction */
  sponsorblockRemove: boolean;
  /** '' means "use default" */
  concurrentFragments: string;
}

export const toFormState = (config: FolderConfig | null, defaults: DownloadOptions): FormState => ({
  channelUrl: config?.channelUrl || '',
  category: config?.category || '',
  maxHeight: config?.maxHeight !== undefined ? String(config.maxHeight) : '',
  subtitlesEnabled: config?.subLangs ? config.subLangs.length > 0 : defaults.subLangs.length > 0,
  subLangs: config?.subLangs ? config.subLangs.join(', ') : '',
  writeComments: config?.writeComments ?? defaults.writeComments,
  extraArgs: config?.extraArgs ? config.extraArgs.join(' ') : '',
  impersonate: config?.impersonate ?? defaults.impersonate ?? false,
  sponsorblockRemove: config?.sponsorblockRemove ?? defaults.sponsorblockRemove ?? false,
  concurrentFragments: config?.concurrentFragments !== undefined ? String(config.concurrentFragments) : '',
});

/**
 * Trimmed text fields: a non-empty value is kept, otherwise the key is
 * removed so config.json only contains what the user actually chose.
 */
const applyTrimmedText = (next: FolderConfig, key: 'channelUrl' | 'category', value: string): void => {
  const trimmed = value.trim();
  if (trimmed) {
    next[key] = trimmed;
  } else {
    delete next[key];
  }
};

/** Numeric fields: an empty form value means "use default" (key removed) */
const applyNumberChoice = (next: FolderConfig, key: 'maxHeight' | 'concurrentFragments', value: string): void => {
  if (value) {
    next[key] = Number(value);
  } else {
    delete next[key];
  }
};

const applySubLangs = (next: FolderConfig, subtitlesEnabled: boolean, rawLangs: string): void => {
  if (!subtitlesEnabled) {
    next.subLangs = [];
  } else {
    const langs = parseSubLangs(rawLangs);
    if (langs.length > 0) {
      next.subLangs = langs;
    } else {
      delete next.subLangs;
    }
  }
};

const applyExtraArgs = (next: FolderConfig, rawArgs: string): void => {
  const extraArgs = parseExtraArgs(rawArgs);
  if (extraArgs.length > 0) {
    next.extraArgs = extraArgs;
  } else {
    delete next.extraArgs;
  }
};

/**
 * Turn the form back into a config object. Keys left at "default" are removed
 * so config.json only contains what the user actually chose; other keys
 * already present in the file are preserved.
 */
export const buildConfig = (form: FormState, existing: FolderConfig | null): FolderConfig => {
  const next: FolderConfig = { ...(existing ?? {}) };

  applyTrimmedText(next, 'channelUrl', form.channelUrl);
  applyTrimmedText(next, 'category', form.category);
  applyNumberChoice(next, 'maxHeight', form.maxHeight);
  applySubLangs(next, form.subtitlesEnabled, form.subLangs);

  next.writeComments = form.writeComments;
  next.impersonate = form.impersonate;
  next.sponsorblockRemove = form.sponsorblockRemove;

  applyNumberChoice(next, 'concurrentFragments', form.concurrentFragments);
  applyExtraArgs(next, form.extraArgs);

  return next;
};
