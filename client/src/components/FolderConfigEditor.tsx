import { useState } from 'react';
import type {
  ApiError,
  DownloadOptions,
  FolderConfig,
  SaveFolderConfigResponse,
} from '@shared/api';
import type { FormState } from '../utils/folderConfigForm';
import { MAX_HEIGHT_CHOICES, buildConfig, toFormState } from '../utils/folderConfigForm';

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
        const errorData: ApiError = await response.json();
        throw new Error(errorData.message || errorData.error || 'Failed to save config');
      }

      const result: SaveFolderConfigResponse = await response.json();
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

  const id = (field: string) => `${field}-${folderPath}`;

  return (
    <div className="folder-config">
      {error && (
        <div className="config-error">
          <p>Błąd: {error}</p>
        </div>
      )}

      {config === null ? (
        <div className="config-empty">
          <p>Plik config.json nie istnieje w tym folderze.</p>
          {!isEditing && (
            <button className="create-config-button" onClick={() => setIsEditing(true)}>
              Utwórz config.json
            </button>
          )}
        </div>
      ) : (
        !isEditing && (
          <button className="edit-config-button" onClick={() => setIsEditing(true)}>
            Edytuj konfigurację
          </button>
        )
      )}

      {isEditing && (
        <div className="config-edit">
          <div className="config-field">
            <label htmlFor={id('channelUrl')}>Adres kanału YouTube:</label>
            <input
              id={id('channelUrl')}
              type="text"
              value={form.channelUrl}
              onChange={(e) => updateForm({ channelUrl: e.target.value })}
              placeholder="https://www.youtube.com/@channel"
              className="config-input"
            />
          </div>

          <div className="config-field">
            <label htmlFor={id('category')}>Kategoria kanału:</label>
            <input
              id={id('category')}
              type="text"
              list={id('categories')}
              value={form.category}
              onChange={(e) => updateForm({ category: e.target.value })}
              placeholder="np. fpv — pozwala filtrować wyszukiwanie"
              className="config-input"
            />
            <datalist id={id('categories')}>
              {knownCategories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="config-field">
            <label htmlFor={id('maxHeight')}>Maks. rozdzielczość:</label>
            <select
              id={id('maxHeight')}
              value={form.maxHeight}
              onChange={(e) => updateForm({ maxHeight: e.target.value })}
              className="config-input"
            >
              <option value="">Domyślnie ({downloadDefaults.maxHeight}p)</option>
              {MAX_HEIGHT_CHOICES.map((height) => (
                <option key={height} value={String(height)}>
                  {height}p
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label className="config-checkbox">
              <input
                type="checkbox"
                checked={form.subtitlesEnabled}
                onChange={(e) => updateForm({ subtitlesEnabled: e.target.checked })}
              />
              Pobieraj napisy
            </label>
            {form.subtitlesEnabled && (
              <>
                <label htmlFor={id('subLangs')}>Języki napisów (po przecinku):</label>
                <input
                  id={id('subLangs')}
                  type="text"
                  value={form.subLangs}
                  onChange={(e) => updateForm({ subLangs: e.target.value })}
                  placeholder={`domyślnie: ${downloadDefaults.subLangs.join(', ') || 'brak'}`}
                  className="config-input"
                />
              </>
            )}
          </div>

          <div className="config-field">
            <label className="config-checkbox">
              <input
                type="checkbox"
                checked={form.writeComments}
                onChange={(e) => updateForm({ writeComments: e.target.checked })}
              />
              Pobieraj komentarze
            </label>
          </div>

          <div className="config-actions">
            <button className="save-config-button" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Zapisywanie...' : 'Zapisz'}
            </button>
            <button className="cancel-config-button" onClick={handleCancel} disabled={isSaving}>
              Anuluj
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
