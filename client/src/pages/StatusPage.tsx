import { useEffect, useReducer } from 'react';
import { Link } from 'react-router-dom';
import type { FolderConfig } from '@shared/api';
import { statusReducer, initialState, StatusActionType } from '../reducers/statusReducer';
import type { StatusData } from '../reducers/statusReducer';
import { FolderSection } from '../components/FolderSection';

export default function StatusPage(): JSX.Element {
  const [state, dispatch] = useReducer(statusReducer, initialState);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        dispatch({ type: StatusActionType.FETCH_START });
        const response = await fetch('/api/status');
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data: StatusData = await response.json();
        dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: data });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An error occurred';
        dispatch({ type: StatusActionType.FETCH_ERROR, payload: errorMessage });
      }
    };

    fetchStatus();
  }, []);

  const handleConfigUpdate = (folderPath: string, config: FolderConfig | null) => {
    if (state.statusData) {
      const updatedStatusData: StatusData = {
        ...state.statusData,
        folderConfigs: {
          ...state.statusData.folderConfigs,
          [folderPath]: config,
        },
      };
      dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: updatedStatusData });
    }
  };

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
            return (
              <div className="status-content">
                <div className="status-section">
                  <h2>Konfiguracja folderów wideo</h2>
                  <div className="folder-sections">
                    {statusData.videosFolderPath.length > 0 ? (
                      statusData.videosFolderPath.map((path, index) => (
                        <FolderSection
                          key={index}
                          folderPath={path}
                          initialConfig={statusData.folderConfigs[path] || null}
                          downloadDefaults={statusData.downloadDefaults}
                          onConfigUpdate={handleConfigUpdate}
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
