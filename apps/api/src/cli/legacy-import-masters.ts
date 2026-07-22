import { runLegacyCli } from './legacy-cli.js';

await runLegacyCli('DRY_RUN', process.argv.slice(2));
