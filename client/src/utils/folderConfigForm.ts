import type { DownloadOptions, FolderConfig } from '@shared/api';

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
  concurrentFragments:
    config?.concurrentFragments !== undefined ? String(config.concurrentFragments) : '',
});

/**
 * Turn the form back into a config object. Keys left at "default" are removed
 * so config.json only contains what the user actually chose; other keys
 * already present in the file are preserved.
 */
export const buildConfig = (form: FormState, existing: FolderConfig | null): FolderConfig => {
  const next: FolderConfig = { ...(existing ?? {}) };

  const channelUrl = form.channelUrl.trim();
  if (channelUrl) {
    next.channelUrl = channelUrl;
  } else {
    delete next.channelUrl;
  }

  const category = form.category.trim();
  if (category) {
    next.category = category;
  } else {
    delete next.category;
  }

  if (form.maxHeight) {
    next.maxHeight = Number(form.maxHeight);
  } else {
    delete next.maxHeight;
  }

  if (!form.subtitlesEnabled) {
    next.subLangs = [];
  } else {
    const langs = parseSubLangs(form.subLangs);
    if (langs.length > 0) {
      next.subLangs = langs;
    } else {
      delete next.subLangs;
    }
  }

  next.writeComments = form.writeComments;
  next.impersonate = form.impersonate;
  next.sponsorblockRemove = form.sponsorblockRemove;

  if (form.concurrentFragments) {
    next.concurrentFragments = Number(form.concurrentFragments);
  } else {
    delete next.concurrentFragments;
  }

  const extraArgs = parseExtraArgs(form.extraArgs);
  if (extraArgs.length > 0) {
    next.extraArgs = extraArgs;
  } else {
    delete next.extraArgs;
  }

  return next;
};
