import { Suspense, useEffect } from 'react';
import { Toaster } from 'react-hot-toast';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import { Loading } from './components/ui/Loading';
import { routes } from './routes';
import { TOAST_OPTIONS } from './utils/toastOptions';
import './App.css';

const router = createBrowserRouter(routes);

interface AppProps {
  /** Test seam: the integration suite passes a memory router */
  router?: ReturnType<typeof createBrowserRouter>;
}

export default function App({ router: customRouter }: AppProps = {}) {
  const activeRouter = customRouter ?? router;

  // The result list puts the reader back where they were, once it has
  // re-fetched the pages that were on screen (hooks/useListScrollRestoration).
  // The browser's own restoration fires while the document is still short, so
  // it clamps to the top and fights the app: the app owns this instead.
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
  }, []);

  return (
    <div className="app">
      <Toaster position="bottom-right" toastOptions={TOAST_OPTIONS} />
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <RouterProvider router={activeRouter} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
