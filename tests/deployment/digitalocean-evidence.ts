import { z } from 'zod';

import type { JsonValue } from '../../src/json-value';

export interface DigitalOceanEvidence {
  dropletId: number;
  name: string;
  regionSlug: string;
  imageSlug: 'ubuntu-26-04-x64';
  sizeSlug: 's-1vcpu-1gb';
  memoryMiB: 1024;
  vcpus: 1;
  diskGiB: 25;
  status: 'active';
  capturedAt: string;
}

/**
 * The provider payload, declared once as a schema.
 *
 * Every constant the acceptance VM must have is a literal here, so a droplet
 * that is the wrong size or image fails to parse rather than being compared
 * field by field afterwards. Unknown keys are stripped, which is what keeps
 * `networks` and friends out of the evidence file.
 */
const evidenceSchema = z.object({
  dropletId: z.number().int().positive(),
  name: z.string().regex(/^mwp-105-acceptance-(measure|verify)-[a-z0-9-]+$/),
  regionSlug: z.string().regex(/^[a-z]+[0-9]+$/),
  imageSlug: z.literal('ubuntu-26-04-x64'),
  sizeSlug: z.literal('s-1vcpu-1gb'),
  memoryMiB: z.literal(1024),
  vcpus: z.literal(1),
  diskGiB: z.literal(25),
  status: z.literal('active'),
  capturedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .refine((value) => !Number.isNaN(Date.parse(value))),
});

export const normalizeDigitalOceanEvidence = (
  value: JsonValue,
  onHostDropletId: string,
): DigitalOceanEvidence => {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) {
    // A root-level issue means the payload was not an object at all, which is
    // a different operator mistake from a droplet that does not match.
    const notAnObject = parsed.error.issues.some(
      (issue) => issue.path.length === 0,
    );
    throw new Error(
      notAnObject
        ? 'DigitalOcean evidence is not an object'
        : 'DigitalOcean evidence does not match the acceptance VM',
    );
  }

  if (!/^[1-9][0-9]*$/.test(onHostDropletId)) {
    throw new Error('on-host DigitalOcean metadata ID is invalid');
  }
  const metadataDropletId = Number(onHostDropletId);
  if (
    !Number.isSafeInteger(metadataDropletId) ||
    metadataDropletId !== parsed.data.dropletId
  ) {
    throw new Error(
      'DigitalOcean control-plane evidence belongs to a different host',
    );
  }

  return parsed.data;
};

const main = async (): Promise<void> => {
  const [, , inputPath, outputPath, onHostDropletId] = Bun.argv;
  if (!inputPath || !outputPath || !onHostDropletId) {
    throw new Error(
      'usage: digitalocean-evidence INPUT OUTPUT ON_HOST_DROPLET_ID',
    );
  }
  const normalized = normalizeDigitalOceanEvidence(
    await Bun.file(inputPath).json(),
    onHostDropletId,
  );
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  if (outputPath === '-') {
    process.stdout.write(body);
  } else {
    await Bun.write(outputPath, body);
  }
};

if (import.meta.main) {
  await main();
}
