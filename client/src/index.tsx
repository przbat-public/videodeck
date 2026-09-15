import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './index.css';

// StrictMode double-renders in development to surface impure renders early;
// production builds are unaffected.
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}
ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
