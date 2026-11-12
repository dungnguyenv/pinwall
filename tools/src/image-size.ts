/*
 * The size gate of the container image: how many bytes `docker save <image>` takes once
 * compressed, which is close to what a registry stores and a node pulls. CI runs it once per
 * platform; an image at or over the limit fails the build.
 *
 *   tsx src/image-size.ts <image> [--max <bytes>]
 */
import { spawn } from 'node:child_process';
import { PassThrough, type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';

/** The image constraint of the release: under 200 MB compressed, per platform. */
export const MAX_COMPRESSED_BYTES = 200_000_000;

/** What produces an image's tar archive. */
export type Save = (image: string) => Readable;

/**
 * The standard output of `docker save <image>`. The stream fails when docker cannot start or
 * exits with a failure, so a missing image is an error and not a small archive.
 */
export const dockerSave: Save = (image) => {
  const archive = new PassThrough();
  const child = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    stderr += text;
  });
  // The archive ends only once the exit status is known, not when stdout ends.
  child.stdout.pipe(archive, { end: false });
  child.on('error', (error) => archive.destroy(error));
  child.on('close', (code, signal) => {
    if (code === 0) archive.end();
    else {
      const how = signal ? `was stopped by ${signal}` : `exited with status ${code}`;
      archive.destroy(new Error(`docker save ${image} ${how}: ${stderr.trim() || 'no output'}`));
    }
  });
  return archive;
};

/** The size in bytes of the archive `save` produces for `image`, gzip level 6. */
export async function compressedSize(image: string, save: Save = dockerSave): Promise<number> {
  let bytes = 0;
  const count = new Writable({
    write(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done();
    },
  });
  await pipeline(save(image), createGzip({ level: 6 }), count);
  return bytes;
}

const USAGE = 'usage: image-size.ts <image> [--max <bytes>]';

/** The image and the limit named on the command line, or why the command line is wrong. */
function parseCommandLine(argv: string[]): { image: string; max: number } | { problem: string } {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { max: { type: 'string' } },
    });
    const max = values.max === undefined ? MAX_COMPRESSED_BYTES : Number(values.max);
    const [image] = positionals;
    if (image === undefined || positionals.length !== 1 || !Number.isSafeInteger(max) || max < 1) {
      return { problem: USAGE };
    }
    return { image, max };
  } catch (error) {
    return { problem: `${error instanceof Error ? error.message : error}\n${USAGE}` };
  }
}

/** Runs the command line; the result is the exit code. */
export async function main(argv: string[], save: Save = dockerSave): Promise<number> {
  const command = parseCommandLine(argv);
  if ('problem' in command) {
    console.error(command.problem);
    return 2;
  }
  const { image, max } = command;

  let size: number;
  try {
    size = await compressedSize(image, save);
  } catch (error) {
    console.error(`${image}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  console.log(`${image}: ${size} bytes compressed (≈ ${(size / 1_000_000).toFixed(1)} MB)`);
  if (size >= max) {
    console.error(`${image}: ${size} bytes is not under the limit of ${max} bytes`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
