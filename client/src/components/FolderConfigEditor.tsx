import { useState } from 'react';
import type {
  ApiError,
  DownloadOptions,
  FolderConfig,
  SaveFolderConfigResponse,
} from '@shared/api';
import type { FormState } from '../utils/folderConfigForm';
import { MAX_HEIGHT_CHOICES, buildConfig, toFormState } from '../utils/folderConfigForm';
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

  // Folder paths contain slashes (and may contain spaces), which are not
  // valid HTML ids — slug them so label[htmlFor] ↔ input[id] keep matching.
  const id = (field: string): string => {
    const slug = folderPath.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return `${field}-${slug}`;
  };

  return (
    <div className="folder-config">
      {error && <ErrorMessage compact>Błąd: {error}</ErrorMessage>}

      {config === null ? (
        <div className="config-empty">
          <p>Plik config.json nie istnieje w tym folderze.</p>
          {!isEditing && (
            <Button variant="primary" onClick={() => setIsEditing(true)}>
              Utwórz config.json
            </Button>
          )}
        </div>
      ) : (
        !isEditing && (
          <Button variant="primary" onClick={() => setIsEditing(true)}>
            Edytuj konfigurację
          </Button>
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
            <Select
              id={id('maxHeight')}
              value={form.maxHeight}
              onChange={(value) => updateForm({ maxHeight: value })}
              className="config-input"
              items={[
                { value: '', label: `Domyślnie (${downloadDefaults.maxHeight}p)` },
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
              label="Pobieraj napisy"
            />
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
            <Checkbox
              checked={form.writeComments}
              onChange={(checked) => updateForm({ writeComments: checked })}
              label="Pobieraj komentarze"
            />
          </div>

          <div className="config-field">
            <label htmlFor={id('extraArgs')}>Dodatkowe argumenty yt-dlp:</label>
            <input
              id={id('extraArgs')}
              type="text"
              value={form.extraArgs}
              onChange={(e) => updateForm({ extraArgs: e.target.value })}
              placeholder="np. --cookies-from-browser chrome --proxy http://127.0.0.1:8080"
              className="config-input"
            />
            <p className="config-hint">
              {downloadDefaults.extraArgs && downloadDefaults.extraArgs.length > 0
                ? `domyślnie: ${downloadDefaults.extraArgs.join(' ')}`
                : 'flagi -f, -o, --download-archive, --merge-output-format i --paths są zarezerwowane'}
            </p>
          </div>

          <div className="config-actions">
            <Button variant="success" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? 'Zapisywanie...' : 'Zapisz'}
            </Button>
            <Button onClick={handleCancel} disabled={isSaving}>
              Anuluj
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
