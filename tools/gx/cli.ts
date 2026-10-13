#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error This module lacks type definitions.
import prettyCli from '@tryghost/pretty-cli';

type Command = { flags: string; desc: string; run: () => void | Promise<void> };
type CommandGroup = { command: (command: Command) => unknown };

const args = process.argv.slice(2);
let commandRun = false;
const cli = prettyCli.Api.get({ name: 'pnpm gx' })
  .help('-h, --help')
  .style(prettyCli.styles)
  .preface('Ghost Dev Tools')
  .strict();

cli.command({
  flags: 'generate',
  desc: 'Generate a package, golden-email or migration.',
  setup(group: CommandGroup) {
    group.command({
      flags: 'package',
      desc: 'Scaffold an internal workspace package.',
      async run() {
        commandRun = true;
        // Keep the existing generator's argument parser and exit behavior.
        process.argv = [...process.argv.slice(0, 2), ...args.slice(2)];
        await import('./create-package.ts');
      },
    });
    for (const command of [
      {
        flags: 'golden-email',
        desc: 'Render the golden email.',
        file: './generate-golden-email.ts',
      },
      { flags: 'migration', desc: 'Scaffold a database migration.', file: './create-migration.js' },
    ]) {
      group.command({
        flags: command.flags,
        desc: command.desc,
        run() {
          commandRun = true;
          const file = fileURLToPath(new URL(command.file, import.meta.url));
          const result = spawnSync(process.execPath, [file, ...args.slice(2)], {
            stdio: 'inherit',
          });
          if (result.error) {
            throw result.error;
          }
          process.exitCode = result.status ?? 1;
        },
      });
    }
  },
});

// Parse only the command path; tool arguments and help flags pass through untouched.
const rootHelp =
  args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0] ?? ''));
const result: unknown = await cli.parse(rootHelp ? ['--help'] : args.slice(0, 2));
assert(result && typeof result === 'object' && 'code' in result && typeof result.code === 'number');
assert('output' in result && typeof result.output === 'string');
if (!commandRun) {
  process.exitCode = rootHelp ? result.code : result.code || 1;
  const output = result.output || cli.getHelp();
  const stream = process.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
} else if (result.code !== 0) {
  process.exitCode = result.code;
  process.stderr.write(`${result.output}\n`);
}
