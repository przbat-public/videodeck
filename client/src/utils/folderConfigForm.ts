import type { DownloadOptions, FolderConfig } from '@shared/api';

export const MAX_HEIGHT_CHOICES = [720, 1080, 1440, 2160];

/** "en, pl" → ['en', 'pl'] */
export const parseSubLangs = (value: string): string[] =>
  value
    .split(/[,\s]+/)
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0);

export interface FormState {
  channelUrl: string;
  /** '' means "use default" */
  maxHeight: string;
  subtitlesEnabled: boolean;
  /** comma separated; empty with subtitles enabled means "use default" */
  subLangs: string;
  writeComments: boolean;
}

export const toFormState = (config: FolderConfig | null, defaults: DownloadOptions): FormState => ({
  channelUrl: config?.channelUrl || '',
  maxHeight: config?.maxHeight !== undefined ? String(config.maxHeight) : '',
  subtitlesEnabled: config?.subLangs ? config.subLangs.length > 0 : defaults.subLangs.length > 0,
  subLangs: config?.subLangs ? config.subLangs.join(', ') : '',
  writeComments: config?.writeComments ?? defaults.writeComments,
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
  return next;
};
