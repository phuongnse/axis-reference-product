import {
  createBusinessObjectRecord,
  getBusinessObjectRecord,
  saveBusinessObjectRecord,
  submitBusinessObjectRecord,
} from './api-generated';
import { createClient } from './api-generated/client';
import type {
  BusinessObjectRecordDetailDto as GeneratedRecordDto,
  BusinessObjectRecordSubmitResultDto as GeneratedSubmitResultDto,
  ProblemDetails,
} from './api-generated/types.gen';
import { product } from './product';

export type RecordDto = {
  id: string;
  revision: number;
  status: 'Draft' | 'Submitted';
  values: Record<string, string[]>;
};

export type Api = ReturnType<typeof api>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type GeneratedResult<T> = {
  data: T | undefined;
  error?: unknown;
  response?: Response;
};

function problemDetail(error: unknown, status: number): string {
  const problem = error as ProblemDetails | undefined;
  return typeof problem?.detail === 'string' && problem.detail.length > 0
    ? problem.detail
    : `Request failed (${status})`;
}

function unwrap<T>(result: GeneratedResult<T>): T {
  if (result.data !== undefined) return result.data;
  const status = result.response?.status ?? 0;
  throw new ApiError(status, problemDetail(result.error, status));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw Error(`Axis response is missing ${path}.`);
  }
  return value;
}

function requiredInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw Error(`Axis response is missing ${path}.`);
  return value as number;
}

function record(value: GeneratedRecordDto): RecordDto {
  if (value.objectKey !== product.objectKey) {
    throw Error('Axis response does not belong to this product.');
  }
  if (value.status !== 'Draft' && value.status !== 'Submitted') {
    throw Error('Axis response has an incompatible record status.');
  }
  return {
    id: requiredString(value.id, 'record id'),
    revision: requiredInteger(value.revision, 'record revision'),
    status: value.status,
    values: value.values,
  };
}

function sameValues(left: Record<string, string[]>, right: Record<string, string[]>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        left[key]?.length === right[key]?.length &&
        left[key]?.every((value, valueIndex) => value === right[key]?.[valueIndex]),
    )
  );
}

export function api(csrfToken: () => string | null) {
  let createIdempotencyKey: string | undefined;
  const client = createClient({
    baseUrl: globalThis.location.origin,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      if (!['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(request.method.toUpperCase())) {
        const token = csrfToken();
        if (!token) throw Error('The browser session has no CSRF token.');
        headers.set('X-CSRF-TOKEN', token);
      }
      return fetch(new Request(request, { headers, credentials: 'same-origin' }));
    },
  });
  const readRecord = async (recordId: string) =>
    record(
      unwrap(
        await getBusinessObjectRecord({
          client,
          path: { recordId },
        }),
      ),
    );
  return {
    readRecord,
    createRecord: async (values: Record<string, string[]>) => {
      createIdempotencyKey ??= crypto.randomUUID();
      const created = record(
        unwrap(
          await createBusinessObjectRecord({
            client,
            path: { objectKey: product.objectKey },
            body: { idempotencyKey: createIdempotencyKey, values },
          }),
        ),
      );
      createIdempotencyKey = undefined;
      return created;
    },
    saveRecord: async (
      recordId: string,
      expectedRevision: number,
      values: Record<string, string[]>,
    ) => {
      try {
        return record(
          unwrap(
            await saveBusinessObjectRecord({
              client,
              path: { recordId },
              body: { expectedRevision, values },
            }),
          ),
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status !== 0) throw cause;
        try {
          const current = await readRecord(recordId);
          if (current.revision > expectedRevision && sameValues(current.values, values)) return current;
        } catch {
          // Preserve the mutation failure when canonical read-back is unavailable.
        }
        throw cause;
      }
    },
    submitRecord: async (recordId: string, expectedRevision: number) => {
      const submit = async (revision: number) => {
        const result: GeneratedSubmitResultDto = unwrap(
          await submitBusinessObjectRecord({
            client,
            path: { recordId },
            body: { expectedRevision: revision },
          }),
        );
        return { isSubmitted: result.isSubmitted, record: record(result.record) };
      };
      try {
        return await submit(expectedRevision);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status !== 0) throw cause;
        let current: RecordDto;
        try {
          current = await readRecord(recordId);
        } catch {
          // Preserve the mutation failure when canonical read-back is unavailable.
          throw cause;
        }
        if (current.status === 'Submitted') return { isSubmitted: true, record: current };
        if (current.revision >= expectedRevision) return await submit(current.revision);
        throw cause;
      }
    },
  };
}
