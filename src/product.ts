import definitionSource from '../solution/business-object-definition.json';
import releaseSource from '../solution/release.json';

export type ProductField = {
  fieldKey: string;
  label: string;
};

if (
  releaseSource.schemaVersion !== 1 ||
  definitionSource.schemaVersion !== 1 ||
  definitionSource.objectKey.length === 0 ||
  definitionSource.fields.length === 0
) {
  throw Error('The installed product source is invalid.');
}

export const product = Object.freeze({
  solutionKey: releaseSource.solutionKey,
  solutionVersion: releaseSource.solutionVersion,
  objectKey: definitionSource.objectKey,
  fields: definitionSource.fields.map(({ fieldKey, label }) => ({ fieldKey, label })),
});
