import { useEffect, useMemo, useState } from 'react';
import { api, type Api, type RecordDto } from './api';
import { beginLogin, getBrowserSession, type BrowserSession } from './auth';
import { copy } from './copy';
import { product } from './product';

function Applications({ client }: { client: Api }) {
  const [record, setRecord] = useState<RecordDto>();
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string>();

  async function create() {
    try {
      setError(undefined);
      setRecord(await client.createRecord(values));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create draft.');
    }
  }

  async function submit() {
    if (!record) return;
    try {
      setError(undefined);
      const saved = await client.saveRecord(record.id, record.revision, values);
      const result = await client.submitRecord(saved.id, saved.revision);
      setRecord(result.record);
      if (!result.isSubmitted) setError(copy.ruleMismatch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit draft.');
    }
  }

  return (
    <section id="applications" aria-label={copy.applications}>
      <h2>{copy.applications}</h2>
      <button onClick={() => void create()}>{copy.createDraft}</button>
      {record && (
        <>
          <p>Status: {record.status}</p>
          {product.fields.map((field) => (
            <label key={field.fieldKey}>
              {field.label}
              <input
                aria-label={field.label}
                disabled={record.status === 'Submitted'}
                value={values[field.fieldKey]?.[0] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.fieldKey]: [event.target.value],
                  }))
                }
              />
            </label>
          ))}
          <button disabled={record.status === 'Submitted'} onClick={() => void submit()}>
            {copy.submit}
          </button>
          {record.status === 'Submitted' && (
            <p>Application submitted. Immutable evidence is available in record history.</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export default function App() {
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<BrowserSession>();
  const client = useMemo(() => api(() => session?.csrfToken ?? null), [session?.csrfToken]);

  useEffect(() => {
    void getBrowserSession()
      .then(setSession)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Sign-in failed.'));
  }, []);

  return (
    <main>
      <header>
        <h1>{copy.applicationTitle}</h1>
        <p>
          Release {product.solutionKey} {product.solutionVersion}
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {session && !session.authenticated ? (
        <button onClick={() => beginLogin('#applications')}>{copy.signIn}</button>
      ) : session?.authenticated ? (
        <>
          <form method="post" action="/bff/logout">
            <input
              type="hidden"
              name="__RequestVerificationToken"
              value={session.csrfToken}
            />
            <button type="submit">Sign out</button>
          </form>
          <Applications client={client} />
        </>
      ) : !error ? (
        <p role="status">Loading session…</p>
      ) : null}
    </main>
  );
}
