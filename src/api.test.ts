import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const values = { applicant_name: ['Alex Rivers'] };

function recordResponse({
  objectKey = 'loan_application',
  revision = 1,
  status = 'Draft',
  responseValues = values,
}: {
  objectKey?: string;
  revision?: number;
  status?: 'Draft' | 'Submitted';
  responseValues?: Record<string, string[]>;
} = {}): Response {
  return new Response(
    JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      objectKey,
      revision,
      status,
      values: responseValues,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function submitResponse(revision: number, status: 'Draft' | 'Submitted'): Response {
  return new Response(
    JSON.stringify({
      isSubmitted: status === 'Submitted',
      record: {
        id: '11111111-1111-4111-8111-111111111111',
        objectKey: 'loan_application',
        revision,
        status,
        values,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function requestBody(fetchMock: ReturnType<typeof vi.fn>, call: number) {
  return JSON.parse(await (fetchMock.mock.calls[call][0] as Request).clone().text());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('product API', () => {
  it('reuses one create idempotency key after a lost response and rotates after canonical success', async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(recordResponse())
      .mockResolvedValueOnce(recordResponse());
    vi.stubGlobal('crypto', { randomUUID });
    vi.stubGlobal('fetch', fetchMock);
    const client = api(() => 'csrf-token');

    await expect(client.createRecord(values)).rejects.toThrow('Request failed (0)');
    await expect(client.createRecord(values)).resolves.toMatchObject({ revision: 1 });
    await expect(client.createRecord(values)).resolves.toMatchObject({ revision: 1 });

    expect((await requestBody(fetchMock, 0)).idempotencyKey).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect((await requestBody(fetchMock, 1)).idempotencyKey).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect((await requestBody(fetchMock, 2)).idempotencyKey).toBe(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect(new URL((fetchMock.mock.calls[0][0] as Request).url).pathname).toBe(
      '/api/business-object-records/loan_application',
    );
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost save response from canonical product read-back', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(recordResponse({ revision: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = api(() => 'csrf-token');

    await expect(
      client.saveRecord('11111111-1111-4111-8111-111111111111', 1, values),
    ).resolves.toMatchObject({ revision: 2, status: 'Draft', values });
    expect((fetchMock.mock.calls[0][0] as Request).method).toBe('PUT');
    expect((fetchMock.mock.calls[1][0] as Request).method).toBe('GET');
  });

  it('recovers a lost submit response from canonical submitted status', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(recordResponse({ revision: 3, status: 'Submitted' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = api(() => 'csrf-token');

    await expect(
      client.submitRecord('11111111-1111-4111-8111-111111111111', 2),
    ).resolves.toMatchObject({ isSubmitted: true, record: { revision: 3, status: 'Submitted' } });
    expect((fetchMock.mock.calls[0][0] as Request).method).toBe('POST');
    expect((fetchMock.mock.calls[1][0] as Request).method).toBe('GET');
  });

  it('automatically retries submit once with the canonical Draft revision after a lost response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(recordResponse({ revision: 2 }))
      .mockResolvedValueOnce(submitResponse(3, 'Submitted'));
    vi.stubGlobal('fetch', fetchMock);
    const client = api(() => 'csrf-token');

    await expect(
      client.submitRecord('11111111-1111-4111-8111-111111111111', 2),
    ).resolves.toMatchObject({ isSubmitted: true, record: { revision: 3 } });
    expect(fetchMock.mock.calls.map((call) => (call[0] as Request).method)).toEqual([
      'POST',
      'GET',
      'POST',
    ]);
    expect((await requestBody(fetchMock, 2)).expectedRevision).toBe(2);
  });

  it('does not submit an intervening Draft revision after a lost response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(recordResponse({ revision: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api(() => 'csrf-token').submitRecord('11111111-1111-4111-8111-111111111111', 2),
    ).rejects.toThrow('Request failed (0)');
    expect(fetchMock.mock.calls.map((call) => (call[0] as Request).method)).toEqual([
      'POST',
      'GET',
    ]);
  });

  it('surfaces a failed automatic submit retry without another read-back loop', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('first response lost'))
      .mockResolvedValueOnce(recordResponse({ revision: 2 }))
      .mockRejectedValueOnce(new TypeError('retry response lost'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api(() => 'csrf-token').submitRecord('11111111-1111-4111-8111-111111111111', 2),
    ).rejects.toThrow('Request failed (0)');
    expect(fetchMock.mock.calls.map((call) => (call[0] as Request).method)).toEqual([
      'POST',
      'GET',
      'POST',
    ]);
  });

  it('rejects a canonical read-back outside the installed product object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(recordResponse({ objectKey: 'foreign_object' })),
    );

    await expect(
      api(() => 'csrf-token').readRecord('11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('Axis response does not belong to this product.');
  });
});
