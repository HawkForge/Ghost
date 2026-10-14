const assert = require('node:assert/strict');
const { RuleTester, ESLint } = require('eslint');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const yaml = require('js-yaml');
const { parser } = require('typescript-eslint');
const rule = require('../../../eslint-rules/service-root-shape.mjs').default;

const helperImport = './define-service';
const prefix = `import { defineService } from '${helperImport}';\n`;
const factory = `defineService('Example', () => ({}))`;
const rejected = [
  ['named function', `export function helper() {} export default ${factory};`, 'runtimeExport'],
  [
    'named re-export',
    `export { helper } from './actions'; export default ${factory};`,
    'runtimeExport',
  ],
  ['wildcard export', `export * from './actions'; export default ${factory};`, 'runtimeExport'],
  ['default class', 'export default class Example {}', 'defaultExport'],
  ['missing default', 'const root = ' + factory, 'defaultExport'],
  ['hand-written initializer', 'export default { init() {}, service: {} };', 'defaultExport'],
  ['spread initializer', `export default { ...${factory}, extras: {} };`, 'defaultExport'],
  [
    'runtime extras factory',
    `export default defineService('Example', create, getExtras());`,
    'explicitExtras',
  ],
  ['spread extras', `export default defineService('Example', create, { ...helpers });`, 'property'],
  [
    'computed extra',
    `export default defineService('Example', create, { [name]: helper });`,
    'property',
  ],
  [
    'duplicate extra',
    `export default defineService('Example', create, { helper, helper });`,
    'duplicate',
  ],
  [
    'import-time extra invocation',
    `export default defineService('Example', create, { start: schedule() });`,
    'value',
  ],
  [
    'extra instance on import',
    `export default defineService('Example', create, { other: new Service() });`,
    'value',
  ],
  [
    'root extension',
    `const root = ${factory}; Object.assign(root, { other: helper }); export default root;`,
    'escape',
  ],
  [
    'root override through alias',
    `const root = ${factory}; const alias = root; alias.init = helper; export default root;`,
    'mutation',
  ],
  [
    'root property deletion',
    `const root = ${factory}; delete root.service; export default root;`,
    'mutation',
  ],
  ['circular aliases', `const a = b; const b = a; export default a;`, 'alias'],
  [
    'wrapped extra invocation',
    `export default defineService('Example', create, { start: (schedule()) as unknown });`,
    'value',
  ],
  [
    'conditional extra invocation',
    `export default defineService('Example', create, { start: enabled ? schedule() : helper });`,
    'value',
  ],
  [
    'root override with a cast',
    `const root = ${factory}; (root as unknown).init = helper; export default root;`,
    'mutation',
  ],
  [
    'CommonJS named export',
    `const root = ${factory}; exports.helper = helper; export default root;`,
    'mutation',
  ],
  [
    'CommonJS replacement',
    `const root = ${factory}; module.exports = { default: root, helper }; export default root;`,
    'mutation',
  ],
  [
    'CommonJS extension',
    `const root = ${factory}; Object.assign(module.exports, { helper }); export default root;`,
    'escape',
  ],
  [
    'extras extension',
    `const extras = { helper }; const root = defineService('Example', create, extras); Object.assign(extras, { other }); export default root;`,
    'escape',
  ],
  [
    'nested extras extension',
    `const root = defineService('Example', create, { helper }); Object.assign(root.extras, { other }); export default root;`,
    'escape',
  ],
];

const tester = new RuleTester({ languageOptions: { parser, sourceType: 'module' } });
const options = [{ helperImport }];
const previous = { describe: RuleTester.describe, it: RuleTester.it, itOnly: RuleTester.itOnly };
try {
  RuleTester.describe = describe;
  RuleTester.it = it;
  RuleTester.itOnly = it.only;
  tester.run('service-root-shape', rule, {
    valid: [
      `export {}; export default ${factory};`,
      `export default ${factory};`,
      `export type { Actor } from './actions'; export { type Result } from './models';
             export interface Context { actor: string } export type Id = string; export default ${factory};`,
      `const extras = { isAvailable, actingContext }; const root = defineService('Example', create, extras); export default root;`,
      `export default defineService('Example', create, { scheduleCheckJob });`,
      `const first = ${factory}; const second = first; export default second;`,
      `const root = ${factory}; function run(root) { root.other = 1; } export default root;`,
      `const root = ${factory}; function run(module, exports) { module.exports = {}; exports.other = 1; } export default root;`,
      `const root = ${factory}; function read() { root.service.check(); } export default root;`,
      `const root = defineService('Example', create, { helper() {}, flag: true, literal: 'value' }); export default root;`,
    ]
      .map((code) => ({ code: prefix + code, filename: 'example.ts', options }))
      .concat([
        {
          code: `import { defineService as managed } from '${helperImport}'; export default managed('Example', create);`,
          filename: 'example.ts',
          options,
        },
      ]),
    invalid: rejected
      .map(([name, code, messageId]) => ({
        name,
        code: prefix + code,
        filename: 'example.ts',
        options,
        errors: [{ messageId }],
      }))
      .concat([
        {
          code: `import { defineService } from './other'; export default ${factory};`,
          filename: 'example.ts',
          options,
          errors: [{ messageId: 'defaultExport' }],
        },
        {
          code:
            prefix +
            `const root = defineService('Example', create, { helper }); const extras = root.extras; extras.other = helper; export default root;`,
          filename: 'example.ts',
          options,
          errors: [{ messageId: 'mutation' }],
        },
        {
          code: prefix + `const root = ${factory}; root['init']++; export default root;`,
          filename: 'example.ts',
          options,
          errors: [{ messageId: 'mutation' }],
        },
        {
          code: prefix + `export default defineService(...args);`,
          filename: 'example.ts',
          options,
          errors: [{ messageId: 'arguments' }],
        },
      ]),
  });
} finally {
  RuleTester.describe = previous.describe;
  RuleTester.it = previous.it;
  RuleTester.itOnly = previous.itOnly;
}

it('enables shape enforcement only for inventory-marked migrated roots', async function () {
  const cwd = path.resolve(__dirname, '../../..');
  const { services } = yaml.load(
    readFileSync(path.join(cwd, 'core/server/services/service-inventory.yaml'), 'utf8'),
  );
  const eslint = new ESLint({ cwd });
  for (const [name, service] of Object.entries(services)) {
    const file = `core/server/services/${service.kind === 'directory' ? `${name}/index.ts` : name}`;
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.rules['service-roots/shape']?.[0] === 2, service.migrated === true, file);
  }
});
