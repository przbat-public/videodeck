import { lazy } from 'react';
import { AppLayout } from './components/AppLayout';
import RouteError from './components/RouteError';

// Lazy routes: the download page does not need the search page's bundle and
// vice versa. Each chunk loads on first navigation (Suspense in App shows a
// spinner) and a failed chunk lands on RouteError instead of a blank page.
// Exported so the integration suite can build a memory router over the same
// tree. The film list is the home route; the download/status page lives at
// /download. The old /videos path is gone on purpose (no redirect): old
// bookmarks land on RouteError.
const StatusPage = lazy(() => import('./pages/StatusPage'));
const VideoListPage = lazy(() => import('./pages/VideoListPage'));
const VideoDetailPage = lazy(() => import('./pages/VideoDetailPage'));

export const routes = [
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <VideoListPage /> },
      { path: 'download', element: <StatusPage /> },
      { path: 'video/:videoId', element: <VideoDetailPage /> },
    ],
  },
];
