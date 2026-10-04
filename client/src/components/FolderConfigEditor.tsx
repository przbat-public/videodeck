import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { SaveFolderConfigResponseSchema } from '@videodeck/shared/schemas';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiSend } from '../utils/apiClient';
import type { FormState } from '../utils/folderConfigForm';
import { buildConfig, FRAGMENT_CHOICES, MAX_HEIGHT_CHOICES, toFormState } from '../utils/folderConfigForm';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { ErrorMessage } from './ui/ErrorMessage';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';

interface FolderConfigEditorProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  /** Server-side defaults used when a key is missing from config.json */
  downloadDefaults: DownloadOptions;
  /** Categories used by other folders, offered as input suggestions */
  knownCategories?: string[];
  /**
   * The form closed itself: saved or cancelled. The caller takes the dialog
   * down, which is also what discards a cancelled edit.
   */
  onClose: () => void;
  /** Focus goes back here once the dialog is gone: the row's ⋯ trigger */
  returnFocus?: HTMLElement | null;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

/**
 * One folder's config.json, in a modal dialog the console's row menu opens.
 * Nothing below the ⋯ entry moves: the dialog closes on save or cancel, so
 * editing a file no longer expands the channel's video list underneath it and
 * leaves the reader hiding it again.
 */
export function FolderConfigEditor({
  folderPath,
  initialConfig,
  downloadDefaults,
  knownCategories = [],
  onClose,
  returnFocus = null,
  onConfigUpdate,
}: FolderConfigEditorProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<FolderConfig | null>(initialConfig);
  const [previousInitialConfig, setPreviousInitialConfig] = useState(initialConfig);
  const [error, setError] = useState<string | null>(null);
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

      const result = await apiSend(
        'PUT',
        '/api/folder/config',
        SaveFolderConfigResponseSchema,
        { folderPath, config: newConfig },
        { failureMessage: (failure) => failure.message ?? t('errors.saveConfig') },
      );

      // The console keeps the answer; this dialog has done its job and closes.
      onConfigUpdate(folderPath, result.config);
      onClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('errors.occurred');
      setError(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  // Cancelling is closing: the form is rebuilt from the config on disk the
  // next time the row menu opens it.
  const handleCancel = () => onClose();

  // Folder paths contain slashes (and may contain spaces), which are not
  // valid HTML ids — slug them so label[htmlFor] ↔ input[id] keep matching.
  const id = (field: string): string => {
    const slug = folderPath.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return `${field}-${slug}`;
  };

  return (
    <Modal title={t('config.title')} onClose={handleCancel} returnFocus={returnFocus}>
      <p className="config-path">{folderPath}</p>

      {error && <ErrorMessage compact>{t('app.error', { message: error })}</ErrorMessage>}

      {config === null && (
        <div className="config-empty">
          <p>{t('config.missingFile')}</p>
        </div>
      )}

      <div className="config-edit">
        <div className="config-field">
          <Checkbox
            checked={form.collection}
            onChange={(checked) => updateForm({ collection: checked })}
            label={t('config.collection')}
          />
        </div>

        {!form.collection && (
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
        )}

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
                  langs: downloadDefaults.subLangs.join(', ') || t('config.none'),
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
              : t('config.extraArgsAllowed')}
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
    </Modal>
  );
}
