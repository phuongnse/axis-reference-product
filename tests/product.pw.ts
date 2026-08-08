import { generateKeyPairSync } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw Error(`${name} is required for real-service product acceptance.`);
  try {
    return new URL(value);
  } catch {
    throw Error(`${name} must be an absolute URL; received ${value}.`);
  }
}

const productUrl = requiredUrl('E2E_BASE_URL');
const axisWebUrl = requiredUrl('E2E_AXIS_WEB_URL');
const maildevUrl = requiredUrl('E2E_MAILDEV_URL');
const solutionPackage = process.env.E2E_SOLUTION_PACKAGE;
if (!solutionPackage) throw Error('E2E_SOLUTION_PACKAGE is required for signed release acceptance.');
const password = 'maple river sunrise';
const oauthArtifact = /(?:access_token|refresh_token|id_token|authorization_code)/i;

type MaildevRecipient = { address: string };
type MaildevMessage = {
  subject?: string;
  text?: string;
  to?: MaildevRecipient[] | MaildevRecipient;
};

function uniqueEmail(): string {
  return `product-e2e.${Date.now()}.${Math.random().toString(36).slice(2, 10)}@test.com`;
}

function servicePublicJwk(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return JSON.stringify({
    kty: jwk.kty,
    crv: jwk.crv,
    kid: `reference-e2e-${Date.now()}`,
    x: jwk.x,
    y: jwk.y,
  });
}

function recipients(value: MaildevMessage['to']): MaildevRecipient[] {
  return !value ? [] : Array.isArray(value) ? value : [value];
}

async function verificationToken(page: Page, email: string): Promise<string> {
  let token = '';
  await expect
    .poll(
      async () => {
        const response = await page.context().request.get(new URL('/email', maildevUrl).toString());
        if (!response.ok()) return '';
        const message = (await response.json() as MaildevMessage[]).find(
          (candidate) =>
            candidate.subject === 'Verify your email address' &&
            recipients(candidate.to).some(
              (recipient) => recipient.address.toLowerCase() === email.toLowerCase(),
            ),
        );
        return message?.text?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
      },
      { message: `verification email for ${email}`, timeout: 30_000 },
    )
    .not.toBe('');

  const response = await page.context().request.get(new URL('/email', maildevUrl).toString());
  const messages = await response.json() as MaildevMessage[];
  token = messages
    .find(
      (candidate) =>
        candidate.subject === 'Verify your email address' &&
        recipients(candidate.to).some(
          (recipient) => recipient.address.toLowerCase() === email.toLowerCase(),
        ),
    )
    ?.text?.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  if (!token) throw Error(`Verification token was not found for ${email}.`);
  return token;
}

async function expectSessionCookie(
  page: Page,
  origin: URL,
  name: string,
): Promise<void> {
  const cookies = (await page.context().cookies([origin.toString()])).filter(
    (cookie) => cookie.name === name,
  );
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({
    name,
    domain: origin.hostname,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

async function expectSessionCookiesAbsent(page: Page): Promise<void> {
  const cookies = await page.context().cookies([productUrl.toString(), axisWebUrl.toString()]);
  expect(cookies.filter((cookie) => cookie.name === '__Host-axis-reference-product-session')).toHaveLength(0);
  expect(cookies.filter((cookie) => cookie.name === '__Host-axis-session')).toHaveLength(0);
}

async function expectNoOAuthArtifacts(page: Page): Promise<void> {
  const artifacts = await page.evaluate(async () => {
    const response = await fetch('/bff/session', { credentials: 'same-origin' });
    return {
      url: window.location.href,
      session: await response.text(),
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    };
  });
  const url = new URL(artifacts.url);
  expect(url.searchParams.has('code')).toBe(false);
  expect(url.searchParams.has('access_token')).toBe(false);
  expect(url.searchParams.has('id_token')).toBe(false);
  expect(JSON.stringify(artifacts)).not.toMatch(oauthArtifact);
}

test('administrator installs the signed release before the applicant submits through the product BFF', async ({
  page,
}) => {
  const email = uniqueEmail();
  const productApiRequests: Array<{ url: string; authorization?: string }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === productUrl.origin && url.pathname.startsWith('/api/')) {
      productApiRequests.push({ url: request.url(), authorization: request.headers().authorization });
    }
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Reference applications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.goto(new URL('/register', axisWebUrl).toString());
  await page.getByLabel('Full name').fill('Alex Rivers');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: /terms of service/i }).check();
  await page.getByRole('button', { name: /create account/i }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const token = await verificationToken(page, email);
  await page.goto(new URL(`/auth/verify?token=${encodeURIComponent(token)}`, axisWebUrl).toString());
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${axisWebUrl.origin}/dashboard$`), { timeout: 30_000 });
  await expect(page.getByRole('banner')).toContainText('Dashboard');

  const organizationName = `Reference E2E ${Date.now()}`;
  await page.getByRole('button', { name: 'Workspace control' }).click();
  await page.getByRole('button', { name: 'Create Organization' }).click();
  const createOrganizationDialog = page.getByRole('dialog', { name: 'Create Organization' });
  await createOrganizationDialog
    .getByRole('textbox', { name: 'Organization name' })
    .fill(organizationName);
  await createOrganizationDialog.getByRole('button', { name: 'Create Organization' }).click();
  await page
    .getByRole('dialog', { name: 'Organization created' })
    .getByRole('button', { name: 'Enter Workspace' })
    .click();
  await expect(page).toHaveURL(new RegExp(`${axisWebUrl.origin}/dashboard$`), { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Workspace control' })).toContainText(
    organizationName,
  );

  await page.goto(new URL('/service-identities', axisWebUrl).toString());
  await expect(page.getByRole('heading', { name: 'Service identities', exact: true })).toBeVisible();
  await page.getByLabel('Client identifier').fill(`reference-e2e-${Date.now()}`);
  await page.getByRole('button', { name: 'Create service identity' }).click();
  await expect(page.getByText('Service identity created')).toBeVisible();
  await page.getByLabel('Public ES256 JWK').fill(servicePublicJwk());
  await page.getByRole('button', { name: 'Add public key' }).click();
  await expect(page.getByText('Public key added')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Key revoked')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke identity' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke identity' }).click();
  await expect(page.getByText('Service identity revoked')).toBeVisible();

  await page.goto(new URL('/solutions', axisWebUrl).toString());
  await expect(page.getByRole('heading', { name: 'Solutions', exact: true })).toBeVisible();
  await page.getByLabel('Signed solution package').setInputFiles(solutionPackage);
  await page.getByRole('button', { name: 'Publish package' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Publish package' }).click();
  await expect(page.getByText('Solution version published')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Install version' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Install version' }).click();
  await expect(page.getByRole('heading', { name: 'Installation progress' })).toBeVisible();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 60_000 });

  await page.goto(new URL('/product-role-assignments', axisWebUrl).toString());
  await expect(page.getByRole('heading', { name: 'Product-role assignments' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Active subject' }).click();
  await page.getByRole('option', { name: /Alex Rivers/ }).click();
  await page.getByRole('combobox', { name: 'Installed product role' }).click();
  await page.getByRole('option', { name: 'Applicant' }).click();
  await page.getByRole('button', { name: 'Assign role' }).click();
  await expect(page.getByText('Product role assigned')).toBeVisible();

  await page.goto(productUrl.toString());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Reference applications' })).toBeVisible();
  await expectNoOAuthArtifacts(page);
  await expectSessionCookie(page, productUrl, '__Host-axis-reference-product-session');
  await expectSessionCookie(page, axisWebUrl, '__Host-axis-session');

  const applications = page.getByRole('region', { name: 'Applications' });
  await applications.getByRole('button', { name: 'Create draft' }).click();
  await applications.getByLabel('Applicant name').fill('Alex Rivers');
  await applications.getByLabel('Contact email').fill(email);
  await applications.getByLabel('Requested amount').fill('5000');
  await applications.getByLabel('Purpose').fill('Home renovation');
  await applications.getByRole('button', { name: 'Submit application' }).click();
  await expect(applications.getByText('Status: Submitted')).toBeVisible();
  await expect(applications.getByText('Application submitted. Immutable evidence is available in record history.')).toBeVisible();

  expect(productApiRequests).not.toHaveLength(0);
  for (const request of productApiRequests) expect(request.authorization).toBeUndefined();

  await page.goto(new URL('/product-role-assignments', axisWebUrl).toString());
  const applicantAssignment = page
    .getByRole('list', { name: 'Current product-role assignments' })
    .locator('li')
    .filter({ hasText: 'Applicant' })
    .filter({ hasText: 'Alex Rivers' });
  await applicantAssignment.getByRole('button', { name: 'Revoke role' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke role' }).click();
  await expect(page.getByText('Product role revoked')).toBeVisible();

  await page.goto(productUrl.toString());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(async () => (await fetch('/api/users/me')).status)).toBe(401);
  await expectSessionCookiesAbsent(page);

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${axisWebUrl.origin}/sign-in(?:[/?]|$)`), {
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
