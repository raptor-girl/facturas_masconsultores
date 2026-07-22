import {
  defaultSourcePath,
  humanResult,
  runLegacyMasterPreview,
  type LegacyPreviewMode,
} from '../infrastructure/legacy/legacy-master-preview.js';

interface CliArgs {
  readonly source: string;
  readonly outputDir?: string;
  readonly dryRun: boolean;
  readonly apply: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source = defaultSourcePath();
  let outputDir: string | undefined;
  let dryRun = false;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      source = argv[index + 1] ?? source;
      index += 1;
    } else if (arg === '--out') {
      outputDir = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--apply') {
      apply = true;
    }
  }
  return outputDir === undefined ? { source, dryRun, apply } : { source, outputDir, dryRun, apply };
}

export async function runLegacyCli(
  mode: LegacyPreviewMode,
  argv: readonly string[],
): Promise<void> {
  const args = parseArgs(argv);
  if (args.apply) {
    throw new Error('Bloqueado: Fase 6.1 sólo permite análisis y dry-run. No ejecute --apply.');
  }
  if (mode === 'DRY_RUN' && !args.dryRun) {
    throw new Error('Bloqueado: use --dry-run. Fase 6.1 no aplica datos reales.');
  }
  const report = await runLegacyMasterPreview({
    sourcePath: args.source,
    mode,
    ...(args.outputDir === undefined ? {} : { outputDir: args.outputDir }),
  });
  // Resultado humano acotado: no imprime dumps ni datos personales.
  // eslint-disable-next-line no-console
  console.log(humanResult(report));
}
