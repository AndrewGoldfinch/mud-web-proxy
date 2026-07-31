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

const requireObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DigitalOcean evidence is not an object');
  }
  return value as Record<string, unknown>;
};

export const normalizeDigitalOceanEvidence = (
  value: unknown,
): DigitalOceanEvidence => {
  const input = requireObject(value);
  const capturedAt = input.capturedAt;
  if (
    !Number.isSafeInteger(input.dropletId) ||
    (input.dropletId as number) <= 0 ||
    typeof input.name !== 'string' ||
    !/^mwp-105-acceptance-(measure|verify)-[a-z0-9-]+$/.test(input.name) ||
    typeof input.regionSlug !== 'string' ||
    !/^[a-z]+[0-9]+$/.test(input.regionSlug) ||
    input.imageSlug !== 'ubuntu-26-04-x64' ||
    input.sizeSlug !== 's-1vcpu-1gb' ||
    input.memoryMiB !== 1024 ||
    input.vcpus !== 1 ||
    input.diskGiB !== 25 ||
    input.status !== 'active' ||
    typeof capturedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(capturedAt) ||
    Number.isNaN(Date.parse(capturedAt))
  ) {
    throw new Error('DigitalOcean evidence does not match the acceptance VM');
  }

  return {
    dropletId: input.dropletId as number,
    name: input.name,
    regionSlug: input.regionSlug,
    imageSlug: 'ubuntu-26-04-x64',
    sizeSlug: 's-1vcpu-1gb',
    memoryMiB: 1024,
    vcpus: 1,
    diskGiB: 25,
    status: 'active',
    capturedAt,
  };
};

const main = async (): Promise<void> => {
  const [, , inputPath, outputPath] = Bun.argv;
  if (!inputPath) {
    throw new Error('usage: digitalocean-evidence INPUT [OUTPUT]');
  }
  const normalized = normalizeDigitalOceanEvidence(
    await Bun.file(inputPath).json(),
  );
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  if (outputPath) {
    await Bun.write(outputPath, body);
  } else {
    process.stdout.write(body);
  }
};

if (import.meta.main) {
  await main();
}
