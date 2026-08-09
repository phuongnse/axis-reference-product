import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skippedDirectories = new Set([
  '.axis-solution',
  '.git',
  'bin',
  'dist',
  'node_modules',
  'obj',
  'test-results',
]);

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else files.push(child);
  }
  return files;
}

test('reference product depends only on public Axis contracts', async () => {
  const files = await filesUnder(root);
  const projectFiles = files.filter((path) => extname(path) === '.csproj');
  for (const projectFile of projectFiles) {
    const source = await readFile(projectFile, 'utf8');
    for (const match of source.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const target = resolve(dirname(projectFile), match[1]);
      assert.equal(
        relative(root, target).split(sep).includes('..'),
        false,
        `${relative(root, projectFile)} references a project outside the product repository`,
      );
    }
  }

  const forbidden = [
    'src/Modules/',
    'Axis.Solutions.Application',
    'Axis.Solutions.Infrastructure',
    'InstallProductPolicyRequest',
    'IBusinessObjectDefinitionSolutionInstaller',
    'IRuleBindingSolutionInstaller',
    'Npgsql',
    'Microsoft.EntityFrameworkCore',
  ];
  const sourceFiles = files.filter((path) =>
    ['.cs', '.csproj', '.js', '.mjs', '.ts', '.tsx'].includes(extname(path)) &&
    path !== fileURLToPath(import.meta.url)
  );
  const violations = [];
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8');
    for (const value of forbidden) {
      if (source.includes(value)) violations.push(`${relative(root, sourceFile)}: ${value}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('reference lifecycle uses the public Axis browser surface', async () => {
  const journey = await readFile(resolve(root, 'tests', 'product.pw.ts'), 'utf8');

  assert.match(journey, /page\.goto\(new URL\('\/solutions', axisWebUrl\)\.toString\(\)\)/);
  assert.doesNotMatch(journey, /\/api\/solutions/);
  assert.doesNotMatch(journey, /InstallProductPolicy|SolutionInstaller|DbContext/);
});
