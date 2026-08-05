import { useEffect, useMemo, useState } from 'react';
import manifestJson from '../manifest.json';
import { api, type Api, type RecordDto } from './api';
import { beginLogin, getBrowserSession, type BrowserSession } from './auth';
import { copy } from './copy';
import { validateManifest, verifyOpenApiDigest, type Manifest } from './manifest';
import { preflight, provision, type Plan, type ProvisionResult } from './planner';

export const manifest = validateManifest(manifestJson) as Manifest;

export function Provisioning({ client, source = manifest, verifyDigest }: { client: Api; source?: Manifest; verifyDigest?: () => Promise<void> }) {
  const [plan, setPlan] = useState<Plan>(); const [error, setError] = useState<string>(); const [progress, setProgress] = useState<string[]>([]); const [result, setResult] = useState<ProvisionResult>();
  async function loadPlan() { try { await (verifyDigest ?? (() => fetch('/openapi.json').then(response => { if (!response.ok) throw Error('Committed OpenAPI input is unavailable.'); return response.arrayBuffer().then(buffer => verifyOpenApiDigest(source, buffer)); })))(); setPlan(await preflight(client, source)); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : 'Preflight failed.'); return false; } }
  async function runPreflight() { setError(undefined); setResult(undefined); await loadPlan(); }
  async function confirm() { if (!plan) return; setError(undefined); setResult(undefined); setProgress([]); try { const next = await provision(client, source, plan, entry => setProgress(current => [...current, entry])); if (await loadPlan()) setResult(next); } catch (cause) { const failure = cause as Error & { completed?: string[]; pending?: string[] }; setProgress(failure.completed ?? []); setError(`${copy.partial} ${failure.message}`); } }
  const hasConflicts = plan?.entries.some(entry => entry.action === 'conflict') ?? false;
  return <section id="provision" aria-label={copy.provisioning}><h2>{copy.provisioning}</h2><button onClick={() => void runPreflight()}>{copy.preflight}</button>{plan && <><p>Release {source.solutionKey} {source.solutionVersion}</p><p>Target workspace: {plan.workspace}</p><ol>{plan.entries.map(entry => <li key={entry.identity} aria-label={`${entry.identity}: ${entry.action}`}>{entry.identity}: {entry.action}. {entry.reason}</li>)}</ol><button autoFocus={!hasConflicts} disabled={hasConflicts} onClick={() => void confirm()}>{copy.confirm}</button></>}{progress.length > 0 && <section aria-live="polite"><h3>Provisioning progress</h3><ol>{progress.map(entry => <li key={entry}>{entry}</li>)}</ol></section>}{result && <p role="status">{copy.success}</p>}{error && <><p role="alert">{error}</p><button onClick={() => void runPreflight()}>{copy.retry}</button></>}</section>;
}

function Applications({ client }: { client: Api }) {
  const [record, setRecord] = useState<RecordDto>(); const [values, setValues] = useState<Record<string, string[]>>({}); const [error, setError] = useState<string>();
  async function create() { try { setError(undefined); setRecord(await client.createRecord(manifest.businessObject.objectKey, values)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create draft.'); } }
  async function submit() { if (!record) return; try { setError(undefined); const saved = await client.saveRecord(record.id, record.revision, values); const result = await client.submitRecord(saved.id, saved.revision); setRecord(result.record); if (!result.isSubmitted) setError(copy.ruleMismatch); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit draft.'); } }
  return <section aria-label={copy.applications}><h2>{copy.applications}</h2><button onClick={() => void create()}>{copy.createDraft}</button>{record && <><p>Status: {record.status}</p>{manifest.businessObject.fields.map(field => <label key={field.fieldKey}>{field.label}<input aria-label={field.label} disabled={record.status === 'Submitted'} value={values[field.fieldKey]?.[0] ?? ''} onChange={event => setValues(current => ({ ...current, [field.fieldKey]: [event.target.value] }))} /></label>)}<button disabled={record.status === 'Submitted'} onClick={() => void submit()}>{copy.submit}</button>{record.status === 'Submitted' && <p>Application submitted. Immutable evidence is available in record history.</p>}</>}</section>;
}

export default function App() {
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<BrowserSession>();
  const client = useMemo(() => api(() => session?.csrfToken ?? null), [session?.csrfToken]);
  useEffect(() => {
    void getBrowserSession()
      .then(setSession)
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Sign-in failed.'));
  }, []);
  return <main><header><h1>{manifest.content.applicationTitle}</h1><p>Release {manifest.solutionKey} {manifest.solutionVersion}</p></header>{error && <p role="alert">{error}</p>}{session && !session.authenticated ? <button onClick={() => beginLogin('#provision')}>{copy.signIn}</button> : session?.authenticated ? <><form method="post" action="/bff/logout"><input type="hidden" name="__RequestVerificationToken" value={session.csrfToken} /><button type="submit">Sign out</button></form><Provisioning client={client} /><Applications client={client} /></> : !error ? <p role="status">Loading session…</p> : null}</main>;
}
