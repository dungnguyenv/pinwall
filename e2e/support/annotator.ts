import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * `pnpm --filter @pinwall/annotator build`, with its output shown only when it fails. The server
 * injects the built script into every page it serves for review, so a suite that opens one
 * builds it first.
 */
export function buildAnnotator(): void {
  try {
    execFileSync('pnpm', ['--filter', '@pinwall/annotator', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`The annotator did not build:\n${stdout ?? ''}${stderr ?? ''}`, {
      cause: error,
    });
  }
}
