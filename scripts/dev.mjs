/**
 * One command for the whole demo environment: the payment rail, SEAL, the
 * console, and the Authenticator app, with their output interleaved and
 * prefixed. The console and the Authenticator are separate origins on purpose --
 * that separation is the security property, not a deployment detail.
 *
 * Each child is launched as `node <js entry>` rather than through the `npx`
 * shim. Node will not spawn a .cmd shim directly on Windows, and routing
 * through a shell to work around that concatenates arguments unescaped.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const procs = [
  ['rail', [tsx, 'watch', 'packages/bank/src/index.ts']],
  ['seal', [tsx, 'watch', 'packages/server/src/index.ts']],
  ['web ', [vite, '--config', 'packages/web/vite.config.ts', 'packages/web']],
  ['auth', [vite, '--config', 'packages/authenticator/vite.config.ts', 'packages/authenticator']],
];

const children = procs.map(([label, args]) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${label} | ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stdout.write(`${label} | exited with code ${code}\n`);
  });
  return child;
});

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
