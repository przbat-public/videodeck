import { useState } from 'react';
import { useVideoSearch, VideoInfo } from './hooks/useVideoSearch';
import SearchBar from './components/SearchBar';
import VideoList from './components/VideoList';
import VideoPlayer from './components/VideoPlayer';
import './App.css';

function App() {
  const { videos, loading, error, search } = useVideoSearch();
  const [selectedVideo, setSelectedVideo] = useState<VideoInfo | null>(null);

  const handleSearch = async (query: string) => {
    await search(query);
  };

  const handlePlay = (video: VideoInfo) => {
    setSelectedVideo(video);
  };

  const handleClosePlayer = () => {
    setSelectedVideo(null);
  };

  return (
    <div className="app">
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
          <VideoList videos={videos} onPlay={handlePlay} />
        )}
      </main>

      <VideoPlayer video={selectedVideo} onClose={handleClosePlayer} />
    </div>
  );
}

export default App;

