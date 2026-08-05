import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App, { Provisioning, manifest } from './App';
import { getBrowserSession } from './auth';
import type { Api, DefinitionDto, RuleBindingDto } from './api';
import { bindingIdentity, type Binding } from './manifest';

vi.mock('./auth', () => ({
  beginLogin: vi.fn(),
  getBrowserSession: vi.fn(),
}));

function bindingResource(binding: Binding, index: number): RuleBindingDto {
  return { ...binding, id: `binding-${index}`, workspaceId: 'workspace', revision: 1 };
}

function publishedDefinition(bindings: RuleBindingDto[]): DefinitionDto {
  return {
    id: 'definition-1', workspaceId: 'workspace', name: manifest.businessObject.name,
    objectKey: manifest.businessObject.objectKey, status: 'Published', revision: 3,
    latestPublishedVersionNumber: 1,
    latestPublishedVersion: {
      versionNumber: 1,
      fields: manifest.businessObject.fields.map(field => ({
        fieldKey: field.fieldKey, label: field.label, fieldType: field.fieldType, order: field.order,
        rules: field.rules.map((definitionKey, order) => {
          const expected = manifest.bindings.find(binding =>
            binding.definitionKey === definitionKey &&
            binding.targetId === `${manifest.businessObject.objectKey}.${field.fieldKey}`,
          );
          if (!expected) throw Error('Invalid test fixture.');
          const binding = bindings.find(candidate => bindingIdentity(candidate) === bindingIdentity(expected));
          if (!binding) throw Error('Invalid test fixture.');
          return { bindingId: binding.id, bindingRevision: binding.revision, order };
        }),
      })),
    },
  };
}

function testClient(): Api {
  const state: { bindings: RuleBindingDto[]; definition?: DefinitionDto } = { bindings: [] };
  return {
    me: vi.fn(async () => ({ workspaceId: 'workspace' })),
    getRuleDefinition: vi.fn(async (definitionKey: string) => ({ definitionKey, publishedVersions: [{ versionNumber: 1 }] })),
    listUsage: vi.fn(async (definitionKey: string, definitionVersion: number) => state.bindings
      .filter(binding => binding.definitionKey === definitionKey && binding.definitionVersion === definitionVersion)
      .map(binding => ({ bindingId: binding.id, definitionKey: binding.definitionKey, definitionVersion: binding.definitionVersion, targetType: binding.targetType, targetId: binding.targetId, useCaseOrTrigger: binding.useCaseOrTrigger }))),
    getBinding: vi.fn(async (id: string) => {
      const binding = state.bindings.find(candidate => candidate.id === id);
      if (!binding) throw Error(`Missing test binding ${id}.`);
      return structuredClone(binding);
    }),
    listDefinitions: vi.fn(async () => ({ items: state.definition ? [{ id: state.definition.id, objectKey: state.definition.objectKey }] : [] })),
    getDefinition: vi.fn(async (id: string) => {
      if (!state.definition || state.definition.id !== id) throw Error(`Missing test definition ${id}.`);
      return structuredClone(state.definition);
    }),
    createBinding: vi.fn(async (binding: Binding) => {
      const created = bindingResource(binding, state.bindings.length);
      state.bindings.push(created);
      return structuredClone(created);
    }),
    createDefinition: vi.fn(async (name: string) => {
      state.definition = { id: 'definition-1', workspaceId: 'workspace', name, objectKey: manifest.businessObject.objectKey, status: 'Unpublished', revision: 1, latestPublishedVersionNumber: null };
      return structuredClone(state.definition);
    }),
    saveDefinition: vi.fn(async (id: string) => {
      if (!state.definition || state.definition.id !== id) throw Error('Missing test definition.');
      state.definition.revision = 2;
      return structuredClone(state.definition);
    }),
    publishDefinition: vi.fn(async (id: string) => {
      if (!state.definition || state.definition.id !== id) throw Error('Missing test definition.');
      state.definition = publishedDefinition(state.bindings);
      return structuredClone(state.definition);
    }),
    createRecord: vi.fn(), saveRecord: vi.fn(), submitRecord: vi.fn(),
  } as Api;
}

describe('Provisioning', () => {
  it('keeps confirmed success visible after refreshed read-back shows every resource reused', async () => {
    const user = userEvent.setup();
    const verifyDigest = vi.fn(async () => undefined);
    render(<Provisioning client={testClient()} verifyDigest={verifyDigest} />);

    await user.click(screen.getByRole('button', { name: 'Run preflight' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm provisioning' }));

    expect((await screen.findByRole('status')).textContent).toBe('Provisioning succeeded. Read-back matches this release.');
    expect(screen.getAllByText(/: reuse\./)).toHaveLength(manifest.bindings.length + 1);
    expect(verifyDigest).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Run preflight' }));

    expect(screen.queryByRole('status')).toBeNull();
    expect(verifyDigest).toHaveBeenCalledTimes(3);
  });
});

describe('App', () => {
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
