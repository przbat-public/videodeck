import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import VideoListPage from './pages/VideoListPage';
import VideoDetailPage from './pages/VideoDetailPage';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <Routes>
          <Route path="/" element={<VideoListPage />} />
          <Route path="/video/:baseName" element={<VideoDetailPage />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
