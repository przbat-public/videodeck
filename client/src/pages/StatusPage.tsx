import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useStatus } from '../hooks/useStatus';
import { FolderSection } from '../components/FolderSection';
import { QueueControls } from '../components/QueueControls';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import { collectCategories } from '../utils/folderConfigForm';

export default function StatusPage(): JSX.Element {
  const { state, updateFolderConfig } = useStatus();

  return (
    <main className="app-main">
      <div className="status-page">
        {state.loading && <Loading message="Ładowanie statusu..." />}

        {state.error && <ErrorMessage>Błąd: {state.error}</ErrorMessage>}

        {state.statusData &&
          (() => {
            const statusData = state.statusData;
            const knownCategories = collectCategories(statusData.folderConfigs);
            return (
              <div className="status-content">
                <QueueControls />
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
