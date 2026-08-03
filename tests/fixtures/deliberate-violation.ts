// THROWAWAY: deliberate violation to prove the defect-class gate fails CI.
// Gate 1 (unsafe-temp-file): predictable name under the shared temp dir.
import os from 'os';
import path from 'path';

export const badTempPath = path.join(
  os.tmpdir(),
  `deliberate-violation-${Date.now()}.json`,
);
