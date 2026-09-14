import { lazy, Suspense } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import type { DefaultToastOptions } from 'react-hot-toast';
import { Toaster } from 'react-hot-toast';
import ErrorBoundary from './components/ErrorBoundary';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { Loading } from './components/ui/Loading';
import RouteError from './components/RouteError';
import './App.css';

// Lazy routes: the status page does not need the search page's bundle and
// vice versa. Each chunk loads on first navigation (Suspense below shows a
// spinner) and a failed chunk lands on RouteError instead of a blank page.
const StatusPage = lazy(() => import('./pages/StatusPage'));
const VideoListPage = lazy(() => import('./pages/VideoListPage'));
const VideoDetailPage = lazy(() => import('./pages/VideoDetailPage'));

const router = createBrowserRouter([
  {
    path: '/',
    errorElement: <RouteError />,
    children: [
      { index: true, element: <StatusPage /> },
      { path: 'videos', element: <VideoListPage /> },
      { path: 'video/:videoId', element: <VideoDetailPage /> },
    ],
  },
]);

function App() {
  const toastOptions: DefaultToastOptions = {
    duration: 10000,
    style: {
      background: '#363636',
      color: '#fff',
    },
    success: {
      duration: 10000,
      iconTheme: {
        primary: '#28a745',
        secondary: '#fff',
      },
    },
    error: {
      duration: 10000,
      iconTheme: {
        primary: '#dc3545',
        secondary: '#fff',
      },
    },
  };

  return (
    <div className="app">
      <Toaster position="bottom-right" toastOptions={toastOptions} />
      <LanguageSwitcher />
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <RouterProvider router={router} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export default App;
