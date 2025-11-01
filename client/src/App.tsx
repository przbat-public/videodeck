import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useVideoSearch } from './hooks/useVideoSearch';
import SearchBar from './components/SearchBar';
import VideoList from './components/VideoList';
import VideoDetail from './pages/VideoDetail';
import './App.css';

function HomePage() {
  const { videos, loading, error, search } = useVideoSearch();

  const handleSearch = async (query: string) => {
    await search(query);
  };

  return (
    <>
      <header className="app-header">
        <h1>Video Search</h1>
        <p>Search through your downloaded YouTube videos</p>
      </header>
      
      <main className="app-main">
        <SearchBar onSearch={handleSearch} loading={loading} />
        
        {error && (
          <div className="error-message">
            <p>Error: {error}</p>
          </div>
        )}
        
        {loading && videos.length === 0 ? (
          <div className="loading">
            <p>Loading videos...</p>
          </div>
        ) : (
          <VideoList videos={videos} />
        )}
      </main>
    </>
  );
}

function App() {
  return (
    <Router>
      <div className="app">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/video/:baseName" element={<VideoDetail />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;

