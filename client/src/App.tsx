import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import type { DefaultToastOptions } from 'react-hot-toast';
import { Toaster } from 'react-hot-toast';
import StatusPage from './pages/StatusPage';
import VideoListPage from './pages/VideoListPage';
import VideoDetailPage from './pages/VideoDetailPage';
import './App.css';

const router = createBrowserRouter([
  { path: '/', element: <StatusPage /> },
  { path: '/videos', element: <VideoListPage /> },
  { path: '/video/:videoId', element: <VideoDetailPage /> },
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
      <RouterProvider router={router} />
    </div>
  );
}

export default App;
