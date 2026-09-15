import { Suspense } from 'react';
import type { DefaultToastOptions } from 'react-hot-toast';
import { Toaster } from 'react-hot-toast';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { Loading } from './components/ui/Loading';
import { useTheme } from './hooks/useTheme';
import { routes } from './routes';
import './App.css';

const router = createBrowserRouter(routes);

interface AppProps {
  /** Test seam: the integration suite passes a memory router */
  router?: ReturnType<typeof createBrowserRouter>;
}

export default function App({ router: customRouter }: AppProps = {}) {
  const activeRouter = customRouter ?? router;
  const { theme, setTheme } = useTheme();
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
      <div className="app-topbar">
        <ThemeSwitcher theme={theme} onThemeChange={setTheme} />
        <LanguageSwitcher />
      </div>
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <RouterProvider router={activeRouter} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
