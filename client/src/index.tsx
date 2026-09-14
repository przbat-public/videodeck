import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';

// StrictMode double-renders in development to surface impure renders early;
// production builds are unaffected.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
