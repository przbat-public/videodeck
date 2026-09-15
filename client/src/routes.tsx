import { lazy } from 'react';
import RouteError from './components/RouteError';

// Lazy routes: the status page does not need the search page's bundle and
// vice versa. Each chunk loads on first navigation (Suspense in App shows a
// spinner) and a failed chunk lands on RouteError instead of a blank page.
// Exported so the integration suite can build a memory router over the same
// tree.
const StatusPage = lazy(() => import('./pages/StatusPage'));
const VideoListPage = lazy(() => import('./pages/VideoListPage'));
const VideoDetailPage = lazy(() => import('./pages/VideoDetailPage'));

export const routes = [
  {
    path: '/',
    errorElement: <RouteError />,
    children: [
      { index: true, element: <StatusPage /> },
      { path: 'videos', element: <VideoListPage /> },
      { path: 'video/:videoId', element: <VideoDetailPage /> },
    ],
  },
];
