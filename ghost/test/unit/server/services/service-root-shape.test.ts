import assert from 'node:assert/strict';
import { readServiceRootExtras } from './service-root-shape';

const helperImport = './define-service';
const prefix = `import { defineService } from '${helperImport}';\n`;
const factory = `defineService('Example', () => ({}))`;
const check = (source: string) =>
  readServiceRootExtras(prefix + source, 'example.ts', helperImport);

describe('migrated service root shape', function () {
  it('accepts a default initializer and erased type exports', function () {
    assert.deepEqual(
      check(`
      export type { Actor } from './actions';
      export { type Result } from './models';
      export interface Context { actor: string }
      export type Id = string;
      export default ${factory};
    `),
      [],
    );
  });

  it('accepts initializer aliases and catalogues literal or const extras', function () {
    assert.deepEqual(
      check(`
      const extras = { isAvailable, actingContext };
      const root = defineService('Example', () => ({}), extras);
      export default root;
    `),
      ['actingContext', 'isAvailable'],
    );
    assert.deepEqual(
      check(`export default defineService('Example', create, { scheduleCheckJob });`),
      ['scheduleCheckJob'],
    );
  });

  it('recognizes an aliased kernel import', function () {
    assert.deepEqual(
      readServiceRootExtras(
        `
      import { defineService as managed } from '${helperImport}';
      export default managed('Example', create);
    `,
        'example.ts',
        helperImport,
      ),
      [],
    );
  });

  const rejected = [
    [
      'named function',
      `export function helper() {} export default ${factory};`,
      /Named runtime exports/,
    ],
    [
      'named re-export',
      `export { helper } from './actions'; export default ${factory};`,
      /Named runtime exports/,
    ],
    [
      'wildcard export',
      `export * from './actions'; export default ${factory};`,
      /Named runtime exports/,
    ],
    ['default class', 'export default class Example {}', /Named runtime exports/],
    ['missing default', 'const root = ' + factory, /Export a default/],
    [
      'hand-written initializer',
      'export default { init() {}, service: {} };',
      /kernel defineService/,
    ],
    ['spread initializer', `export default { ...${factory}, extras: {} };`, /kernel defineService/],
    [
      'runtime extras factory',
      `export default defineService('Example', create, getExtras());`,
      /explicit object/,
    ],
    [
      'spread extras',
      `export default defineService('Example', create, { ...helpers });`,
      /List extras explicitly/,
    ],
    [
      'computed extra',
      `export default defineService('Example', create, { [name]: helper });`,
      /static name/,
    ],
    [
      'duplicate extra',
      `export default defineService('Example', create, { helper, helper });`,
      /each extra once/,
    ],
    [
      'import-time extra invocation',
      `export default defineService('Example', create, { start: schedule() });`,
      /helper references/,
    ],
    [
      'extra instance on import',
      `export default defineService('Example', create, { other: new Service() });`,
      /helper references/,
    ],
    [
      'root extension',
      `const root = ${factory}; Object.assign(root, { other: helper }); export default root;`,
      /declare helpers through extras/,
    ],
    [
      'root override through alias',
      `const root = ${factory}; const alias = root; alias.init = helper; export default root;`,
      /override initializer/,
    ],
    [
      'root property deletion',
      `const root = ${factory}; delete root.service; export default root;`,
      /mutate initializer/,
    ],
    ['circular aliases', `const a = b; const b = a; export default a;`, /resolve to local const/],
    [
      'wrapped extra invocation',
      `export default defineService('Example', create, { start: (schedule()) as unknown });`,
      /helper references/,
    ],
    [
      'conditional extra invocation',
      `export default defineService('Example', create, { start: enabled ? schedule() : helper });`,
      /helper references/,
    ],
    [
      'root override with a cast',
      `const root = ${factory}; (root as unknown).init = helper; export default root;`,
      /override initializer/,
    ],
    [
      'CommonJS named export',
      `const root = ${factory}; exports.helper = helper; export default root;`,
      /CommonJS exports/,
    ],
    [
      'CommonJS replacement',
      `const root = ${factory}; module.exports = { default: root, helper }; export default root;`,
      /CommonJS exports/,
    ],
    [
      'CommonJS extension',
      `const root = ${factory}; Object.assign(module.exports, { helper }); export default root;`,
      /declare helpers through extras/,
    ],
    [
      'extras extension',
      `const extras = { helper }; const root = defineService('Example', create, extras); Object.assign(extras, { other }); export default root;`,
      /declare helpers through extras/,
    ],
    [
      'nested extras extension',
      `const root = defineService('Example', create, { helper }); Object.assign(root.extras, { other }); export default root;`,
      /declare helpers through extras/,
    ],
  ] as const;
  for (const [name, source, message] of rejected) {
    it(`rejects ${name}`, function () {
      assert.throws(() => check(source), message);
    });
  }

  it('rejects a lookalike helper imported from another module', function () {
    assert.throws(
      () =>
        readServiceRootExtras(
          `
      import { defineService } from './other';
      export default ${factory};
    `,
          'example.ts',
          helperImport,
        ),
      /kernel defineService/,
    );
  });
});
