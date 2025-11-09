import { useState, useEffect } from 'react';
import { FolderConfig } from '../reducers/statusReducer';

interface FolderConfigEditorProps {
  folderPath: string;
  initialConfig: FolderConfig | null;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}

export function FolderConfigEditor({ 
  folderPath, 
  initialConfig, 
  onConfigUpdate 
}: FolderConfigEditorProps) {
  const [config, setConfig] = useState<FolderConfig | null>(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [channelUrl, setChannelUrl] = useState(initialConfig?.channelUrl || '');
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when initialConfig changes
  useEffect(() => {
    setConfig(initialConfig);
    setChannelUrl(initialConfig?.channelUrl || '');
  }, [initialConfig]);

  const handleSave = async () => {
    try {
      setError(null);
      setIsSaving(true);
      const newConfig: FolderConfig = {
        channelUrl: channelUrl.trim() || undefined,
      };

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
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save config');
      }

      const result = await response.json();
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
    setChannelUrl(config?.channelUrl || '');
    setIsEditing(false);
    setError(null);
  };

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
            <button 
              className="create-config-button"
              onClick={() => setIsEditing(true)}
            >
              Utwórz config.json
            </button>
          )}
        </div>
      ) : (
        <div>
          {!isEditing && (
            <div className="config-info">
              <div className="config-field">
                <label>Adres kanału YouTube:</label>
                <p className="config-value">
                  {config.channelUrl || <em>Nie ustawiono</em>}
                </p>
              </div>
              <button 
                className="edit-config-button"
                onClick={() => setIsEditing(true)}
              >
                Edytuj konfigurację
              </button>
            </div>
          )}
        </div>
      )}

      {isEditing && (
        <div className="config-edit">
          <div className="config-field">
            <label htmlFor={`channelUrl-${folderPath}`}>
              Adres kanału YouTube:
            </label>
            <input
              id={`channelUrl-${folderPath}`}
              type="text"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="https://www.youtube.com/@channel"
              className="config-input"
            />
          </div>
          <div className="config-actions">
            <button 
              className="save-config-button"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Zapisywanie...' : 'Zapisz'}
            </button>
            <button 
              className="cancel-config-button"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Anuluj
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

