import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import source from '../manifest.json';
import {
  canonicalManifestJson,
  validateManifest,
  verifyOpenApiDigest,
} from './manifest';

function openApiArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('manifest', () => {
  it('canonicalizes semantic arrays deterministically and verifies the OpenAPI digest', async () => {
    const manifest = validateManifest(source);
    const reordered = structuredClone(source);
    reordered.bindings.reverse();
    reordered.businessObject.fields.reverse();

    expect(canonicalManifestJson(manifest)).toBe(
      canonicalManifestJson(validateManifest(reordered)),
    );
    await expect(
      verifyOpenApiDigest(manifest, openApiArrayBuffer(await readFile('openapi.json'))),
    ).resolves.toBeUndefined();
  });

  it('rejects unknown properties and duplicate binding identities', () => {
    const unknown = structuredClone(source) as Record<string, unknown>;
    unknown.extra = true;
    expect(() => validateManifest(unknown)).toThrow('manifest.extra is unknown');

    const duplicate = structuredClone(source);
    duplicate.bindings.push(structuredClone(duplicate.bindings[0]));
    expect(() => validateManifest(duplicate)).toThrow('duplicates semantic identity');
  });

  it('rejects orphan bindings, duplicate attachments, and non-contiguous field order', () => {
    const orphan = structuredClone(source);
    orphan.businessObject.fields[0].rules = [];
    expect(() => validateManifest(orphan)).toThrow('is not attached to its target field');

    const duplicateAttachment = structuredClone(source);
    duplicateAttachment.businessObject.fields[0].rules.push('field.required');
    expect(() => validateManifest(duplicateAttachment)).toThrow('is duplicated');

    const orderGap = structuredClone(source);
    orderGap.businessObject.fields[3].order = 4;
    expect(() => validateManifest(orderGap)).toThrow(
      'fields orders must be contiguous from zero',
    );
  });

  it('requires an explicit canonical Choice configuration only for Choice fields', () => {
    const missing = structuredClone(source);
    missing.businessObject.fields[0].fieldType = 'Choice';
    expect(() => validateManifest(missing)).toThrow(
      'choiceConfiguration is required for Choice',
    );

    const valid = structuredClone(source) as unknown as {
      businessObject: { fields: Array<Record<string, unknown>> };
    };
    valid.businessObject.fields[0].fieldType = 'Choice';
    valid.businessObject.fields[0].choiceConfiguration = {
      selectionMode: 'Single',
      options: [
        { optionKey: 'individual', label: 'Individual', order: 0 },
        { optionKey: 'business', label: 'Business', order: 1 },
      ],
    };
    expect(validateManifest(valid).businessObject.fields[0].choiceConfiguration).toEqual(
      valid.businessObject.fields[0].choiceConfiguration,
    );
  });
});
