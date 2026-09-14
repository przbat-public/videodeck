import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useStatus } from '../hooks/useStatus';
import { FolderSection } from '../components/FolderSection';
import { collectCategories } from '../utils/folderConfigForm';

export default function StatusPage(): JSX.Element {
  const { state, updateFolderConfig } = useStatus();

  return (
    <main className="app-main">
      <div className="status-page">
        {state.loading && (
          <div className="loading">
            <p>Ładowanie statusu...</p>
          </div>
        )}

        {state.error && (
          <div className="error-message">
            <p>Błąd: {state.error}</p>
          </div>
        )}

        {state.statusData &&
          (() => {
            const statusData = state.statusData;
            const knownCategories = collectCategories(statusData.folderConfigs);
            return (
              <div className="status-content">
                <div className="status-section">
                  <h2>Konfiguracja folderów wideo</h2>
                  <div className="folder-sections">
                    {statusData.videosFolderPath.length > 0 ? (
                      statusData.videosFolderPath.map((path) => (
                        <FolderSection
                          key={path}
                          folderPath={path}
                          initialConfig={statusData.folderConfigs[path] || null}
                          downloadDefaults={statusData.downloadDefaults}
                          indexed={statusData.indexedFolders.includes(path)}
                          initialListExists={statusData.listExists[path] ?? null}
                          knownCategories={knownCategories}
                          onConfigUpdate={updateFolderConfig}
                        />
                      ))
                    ) : (
                      <p>Brak skonfigurowanych ścieżek</p>
                    )}
                  </div>
                </div>

                <div className="status-actions">
                  <Link to="/videos" className="status-link">
                    Przejdź do listy filmów
                  </Link>
                </div>
              </div>
            );
          })()}
      </div>
    </main>
  );
}
