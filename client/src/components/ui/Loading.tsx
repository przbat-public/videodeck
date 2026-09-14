import type { JSX } from 'react';

interface LoadingProps {
  message?: string;
}

/** Standard "loading" block used by every page */
export function Loading({ message = 'Ładowanie...' }: LoadingProps): JSX.Element {
  return (
    <div className="ui-loading" role="status">
      <p>{message}</p>
    </div>
  );
}
