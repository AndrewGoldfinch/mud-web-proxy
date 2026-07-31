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
  onHostDropletId: string,
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

  if (!/^[1-9][0-9]*$/.test(onHostDropletId)) {
    throw new Error('on-host DigitalOcean metadata ID is invalid');
  }
  const metadataDropletId = Number(onHostDropletId);
  if (
    !Number.isSafeInteger(metadataDropletId) ||
    metadataDropletId !== input.dropletId
  ) {
    throw new Error(
      'DigitalOcean control-plane evidence belongs to a different host',
    );
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
