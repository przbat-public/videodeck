import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import VideoListPage from './pages/VideoListPage';
import VideoDetailPage from './pages/VideoDetailPage';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <Toaster
          position="bottom-right"
          toastOptions={{
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
          }}
        />
        <Routes>
          <Route path="/" element={<VideoListPage />} />
          <Route path="/video/:baseName" element={<VideoDetailPage />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
