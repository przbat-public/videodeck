import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders the shell and the routed page inside it', () => {
    const router = createMemoryRouter([{ path: '/', element: <h1>Testowa strona</h1> }], {
      initialEntries: ['/'],
    });

    render(<App router={router} />);

    expect(screen.getByRole('heading', { name: 'Testowa strona' })).toBeInTheDocument();
  });
});
