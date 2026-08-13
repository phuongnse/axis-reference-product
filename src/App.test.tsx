import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { getBrowserSession } from './auth';

vi.mock('./auth', () => ({
  beginLogin: vi.fn(),
  getBrowserSession: vi.fn(),
}));

describe('App', () => {
  it('renders only the installed-product journey for an authenticated user', async () => {
    vi.mocked(getBrowserSession).mockResolvedValue({
      authenticated: true,
      csrfToken: 'csrf-token',
      user: { userId: 'user-1', email: 'user@example.test', name: 'User' },
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Reference applications' })).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Applications' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft' })).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Provisioning' })).toBeNull();
  });

  it('posts the server-named antiforgery token to the BFF logout endpoint', async () => {
    vi.mocked(getBrowserSession).mockResolvedValue({
      authenticated: true,
      csrfToken: 'csrf-token',
      user: { userId: 'user-1', email: 'user@example.test', name: 'User' },
    });

    render(<App />);

    const form = (await screen.findByRole('button', { name: 'Sign out' })).closest('form');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/bff/logout');
    expect(form?.querySelector('input[name="__RequestVerificationToken"]')?.getAttribute('value')).toBe('csrf-token');
  });
});
