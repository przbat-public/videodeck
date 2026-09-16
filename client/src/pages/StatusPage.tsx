import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderSection } from '../components/FolderSection';
import { QueueControls } from '../components/QueueControls';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Loading } from '../components/ui/Loading';
import { useStatus } from '../hooks/useStatus';
import { collectCategories } from '../utils/folderConfigForm';

export default function StatusPage(): JSX.Element {
  const { state, updateFolderConfig } = useStatus();
  const { t } = useTranslation();

  return (
    <main className="app-main">
      <div className="status-page">
        {state.loading && <Loading message={t('status.loading')} />}

        {state.error && <ErrorMessage>{t('app.error', { message: state.error })}</ErrorMessage>}

        {state.statusData &&
          (() => {
            const statusData = state.statusData;
            const knownCategories = collectCategories(statusData.folderConfigs);
            return (
              <div className="status-content">
                <QueueControls />
                <div className="status-section">
                  <h2>{t('status.foldersTitle')}</h2>
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
                      <p>{t('status.noFolders')}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
      </div>
    </main>
  );
}
