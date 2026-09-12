import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import type { DefaultToastOptions } from 'react-hot-toast';
import { Toaster } from 'react-hot-toast';
import StatusPage from './pages/StatusPage';
import VideoListPage from './pages/VideoListPage';
import VideoDetailPage from './pages/VideoDetailPage';
import './App.css';

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
    <Router>
      <div className="app">
        <Toaster position="bottom-right" toastOptions={toastOptions} />
        <Routes>
          <Route path="/" element={<StatusPage />} />
          <Route path="/videos" element={<VideoListPage />} />
          <Route path="/video/:videoId" element={<VideoDetailPage />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
