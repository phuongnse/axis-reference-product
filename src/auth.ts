export type BrowserSession = {
  authenticated: boolean;
  csrfToken: string;
  user: { userId: string; email: string; name: string } | null;
};

export async function getBrowserSession(): Promise<BrowserSession> {
  const response = await fetch('/bff/session', { credentials: 'same-origin' });
  if (!response.ok) throw Error('Could not resolve the browser session.');
  const value = (await response.json()) as Partial<BrowserSession>;
  if (
    typeof value.authenticated !== 'boolean' ||
    typeof value.csrfToken !== 'string' ||
    value.csrfToken.length === 0 ||
    (value.authenticated &&
      (!value.user ||
        typeof value.user.userId !== 'string' ||
        typeof value.user.email !== 'string' ||
        typeof value.user.name !== 'string'))
  ) {
    throw Error('The browser session response is invalid.');
  }
  return value as BrowserSession;
}

export function beginLogin(returnTo = `${location.pathname}${location.search}${location.hash}`): void {
  location.assign(`/bff/login?${new URLSearchParams({ returnUrl: returnTo })}`);
}
