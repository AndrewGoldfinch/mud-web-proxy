/**
 * The mock MUD the Compose smoke test points at, run on the host.
 *
 * A host process rather than another container: the proxy reaching it through
 * `host.docker.internal` is the only part of this that is test scaffolding.
 * Everything the test asserts about the edge is inherited from compose.yaml.
 */
import { createIREMUD } from '../e2e/mock-mud';

const port = Number(process.argv[2] ?? 6450);
const mud = createIREMUD();
mud.setPort(port);

await mud.start();
console.log(`mock-target: listening on ${port}`);

const stop = async () => {
  await mud.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
