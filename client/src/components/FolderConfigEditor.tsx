import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { ApiErrorSchema, SaveFolderConfigResponseSchema } from '@videodeck/shared/schemas';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormState } from '../utils/folderConfigForm';
import { buildConfig, FRAGMENT_CHOICES, MAX_HEIGHT_CHOICES, toFormState } from '../utils/folderConfigForm';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { ErrorMessage } from './ui/ErrorMessage';
import { Select } from './ui/Select';

interface FolderConfigEditorProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  /** Server-side defaults used when a key is missing from config.json */
  downloadDefaults: DownloadOptions;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

export function FolderConfigEditor({
  folderPath,
  initialConfig,
  downloadDefaults,
  knownCategories = [],
  onConfigUpdate,
}: FolderConfigEditorProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<FolderConfig | null>(initialConfig);
  const [previousInitialConfig, setPreviousInitialConfig] = useState(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => toFormState(initialConfig, downloadDefaults));
  const [isSaving, setIsSaving] = useState(false);

  // Reset local state when the parent replaces the config (e.g. after a save
  // or an external change). Adjusted during render instead of in an effect —
  // React docs: "adjusting state when a prop changes".
  if (initialConfig !== previousInitialConfig) {
    setPreviousInitialConfig(initialConfig);
    setConfig(initialConfig);
    setForm(toFormState(initialConfig, downloadDefaults));
  }

  const updateForm = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    try {
      setError(null);
      setIsSaving(true);
      const newConfig = buildConfig(form, config);

      const response = await fetch('/api/folder/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderPath,
          config: newConfig,
        }),
      });

      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
        throw new Error(parsed.success ? (parsed.data.message ?? parsed.data.error) : 'Failed to save config');
      }

      const result = SaveFolderConfigResponseSchema.parse(await response.json());
      setConfig(result.config);
      onConfigUpdate(folderPath, result.config);
      setIsEditing(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setForm(toFormState(config, downloadDefaults));
    setIsEditing(false);
    setError(null);
  };

  // Folder paths contain slashes (and may contain spaces), which are not
  // valid HTML ids — slug them so label[htmlFor] ↔ input[id] keep matching.
  const id = (field: string): string => {
    const slug = folderPath.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return `${field}-${slug}`;
  };

  return (
    <div className="folder-config">
      {error && <ErrorMessage compact>{t('app.error', { message: error })}</ErrorMessage>}

      {config === null ? (
        <div className="config-empty">
          <p>{t('config.missingFile')}</p>
          {!isEditing && (
            <Button variant="primary" onClick={() => setIsEditing(true)}>
              {t('config.create')}
            </Button>
          )}
        </div>
      ) : (
        !isEditing && (
          <Button variant="primary" onClick={() => setIsEditing(true)}>
            {t('config.edit')}
          </Button>
        )
      )}

      {isEditing && (
        <div className="config-edit">
          <div className="config-field">
            <label htmlFor={id('channelUrl')}>{t('config.channelUrl')}</label>
            <input
              id={id('channelUrl')}
              type="text"
              value={form.channelUrl}
              onChange={(e) => updateForm({ channelUrl: e.target.value })}
              placeholder={t('config.channelUrlPlaceholder')}
              className="config-input"
            />
          </div>

          <div className="config-field">
            <label htmlFor={id('category')}>{t('config.category')}</label>
            <input
              id={id('category')}
              type="text"
              list={id('categories')}
              value={form.category}
              onChange={(e) => updateForm({ category: e.target.value })}
              placeholder={t('config.categoryPlaceholder')}
              className="config-input"
            />
            <datalist id={id('categories')}>
              {knownCategories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="config-field">
            <label htmlFor={id('maxHeight')}>{t('config.maxHeight')}</label>
            <Select
              id={id('maxHeight')}
              value={form.maxHeight}
              onChange={(value) => updateForm({ maxHeight: value })}
              className="config-input"
              items={[
                {
                  value: '',
                  label: t('config.maxHeightDefault', { height: downloadDefaults.maxHeight }),
                },
                ...MAX_HEIGHT_CHOICES.map((height) => ({
                  value: String(height),
                  label: `${height}p`,
                })),
              ]}
            />
          </div>

          <div className="config-field">
            <Checkbox
              checked={form.subtitlesEnabled}
              onChange={(checked) => updateForm({ subtitlesEnabled: checked })}
              label={t('config.subtitles')}
            />
            {form.subtitlesEnabled && (
              <>
                <label htmlFor={id('subLangs')}>{t('config.subtitleLangs')}</label>
                <input
                  id={id('subLangs')}
                  type="text"
                  value={form.subLangs}
                  onChange={(e) => updateForm({ subLangs: e.target.value })}
                  placeholder={t('config.subtitleLangsPlaceholder', {
                    langs: downloadDefaults.subLangs.join(', ') || 'brak',
                  })}
                  className="config-input"
                />
              </>
            )}
          </div>

          <div className="config-field">
            <Checkbox
              checked={form.writeComments}
              onChange={(checked) => updateForm({ writeComments: checked })}
              label={t('config.comments')}
            />
          </div>

          <div className="config-field">
            <Checkbox
              checked={form.impersonate}
              onChange={(checked) => updateForm({ impersonate: checked })}
              label={t('config.impersonate')}
            />
          </div>

          <div className="config-field">
            <Checkbox
              checked={form.sponsorblockRemove}
              onChange={(checked) => updateForm({ sponsorblockRemove: checked })}
              label={t('config.sponsorblock')}
            />
          </div>

          <div className="config-field">
            <label htmlFor={id('concurrentFragments')}>{t('config.concurrentFragments')}</label>
            <Select
              id={id('concurrentFragments')}
              value={form.concurrentFragments}
              onChange={(value) => updateForm({ concurrentFragments: value })}
              className="config-input"
              items={[
                {
                  value: '',
                  label: t('config.concurrentFragmentsDefault', {
                    count: downloadDefaults.concurrentFragments ?? 1,
                  }),
                },
                ...FRAGMENT_CHOICES.map((fragments) => ({
                  value: String(fragments),
                  label: String(fragments),
                })),
              ]}
            />
          </div>

          <div className="config-field">
            <label htmlFor={id('extraArgs')}>{t('config.extraArgs')}</label>
            <input
              id={id('extraArgs')}
              type="text"
              value={form.extraArgs}
              onChange={(e) => updateForm({ extraArgs: e.target.value })}
              placeholder={t('config.extraArgsPlaceholder')}
              className="config-input"
            />
            <p className="config-hint">
              {downloadDefaults.extraArgs && downloadDefaults.extraArgs.length > 0
                ? t('config.subtitleLangsPlaceholder', {
                    langs: downloadDefaults.extraArgs.join(' '),
                  })
                : t('config.extraArgsReserved')}
            </p>
          </div>

          <div className="config-actions">
            <Button variant="success" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? t('config.saving') : t('config.save')}
            </Button>
            <Button onClick={handleCancel} disabled={isSaving}>
              {t('config.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
