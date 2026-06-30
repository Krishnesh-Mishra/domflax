/**
 * @domflax/cli — the interactive wizard (DESIGN-DECISIONS Q17).
 *
 * Launched only on a no-args run in a TTY (gated by the caller via {@link shouldPrompt}); it NEVER
 * runs under `--no-interactive`/`--yes` or a non-TTY, so it can't hang CI. It produces the SAME
 * {@link CliOptions} object the flag parser does. A cancel at any step aborts cleanly.
 */

import { cancel, intro, isCancel, multiselect, outro, select, text } from '@clack/prompts';

import type { CliOptions, ProviderOption } from './options';
import { DEFAULT_SAFETY } from './options';
import { builtinPatternNames } from './transform';

/** Sentinel returned when the user cancels the wizard. */
export const WIZARD_CANCELLED = Symbol('domflax.wizard.cancelled');

function cancelled<T>(value: T | symbol): value is symbol {
  return isCancel(value);
}

/**
 * Run the guided wizard, returning a fully-built {@link CliOptions} or {@link WIZARD_CANCELLED}.
 * `base` carries any flags the user also passed (defaults preserved for everything not asked).
 */
export async function runWizard(base: CliOptions): Promise<CliOptions | typeof WIZARD_CANCELLED> {
  intro('domflax — optimize your markup');

  const pathInput = await text({
    message: 'Which folder, glob, or file should domflax optimize?',
    placeholder: 'src',
    defaultValue: 'src',
  });
  if (cancelled(pathInput)) return done();

  const outputMode = await select({
    message: 'Where should the optimized files go?',
    options: [
      { value: 'out', label: 'A new ./domflax-out folder', hint: 'safe default' },
      { value: 'out-custom', label: 'A custom output folder' },
      { value: 'dry-run', label: 'Preview only (dry run)', hint: 'writes nothing' },
      { value: 'overwrite', label: 'Overwrite the source in place', hint: 'dangerous — needs clean git' },
    ],
    initialValue: 'out',
  });
  if (cancelled(outputMode)) return done();

  let out: string | null = null;
  let dryRun = false;
  let dangerouslyOverwriteSource = false;
  if (outputMode === 'out-custom') {
    const dir = await text({
      message: 'Output folder:',
      placeholder: 'domflax-out',
      defaultValue: 'domflax-out',
    });
    if (cancelled(dir)) return done();
    out = String(dir);
  } else if (outputMode === 'dry-run') {
    dryRun = true;
  } else if (outputMode === 'overwrite') {
    dangerouslyOverwriteSource = true;
  }

  const allPasses = builtinPatternNames();
  const passSelection = await multiselect({
    message: 'Which optimization passes should run?',
    options: allPasses.map((name) => ({ value: name, label: name })),
    initialValues: [...allPasses],
    required: true,
  });
  if (cancelled(passSelection)) return done();
  const passes = passSelection as string[];

  const provider = await select<ProviderOption>({
    message: 'How should class names resolve to styles?',
    options: [
      { value: 'auto', label: 'Auto (Tailwind)', hint: 'default' },
      { value: 'tailwind', label: 'Tailwind' },
      { value: 'custom', label: 'Custom CSS files' },
    ],
    initialValue: 'auto',
  });
  if (cancelled(provider)) return done();

  let css: readonly string[] = base.css;
  if (provider === 'custom') {
    const cssInput = await text({
      message: 'CSS files (space-separated):',
      placeholder: 'src/styles.css',
    });
    if (cancelled(cssInput)) return done();
    css = String(cssInput)
      .split(/\s+/)
      .filter((s) => s.length > 0);
  }

  outro('Ready — running domflax.');

  return {
    ...base,
    paths: [String(pathInput)],
    out,
    provider: provider as ProviderOption,
    css,
    dryRun,
    dangerouslyOverwriteSource,
    passes: passes.length === allPasses.length ? null : passes,
    safety: base.safety ?? DEFAULT_SAFETY,
  };

  function done(): typeof WIZARD_CANCELLED {
    cancel('Cancelled — nothing was written.');
    return WIZARD_CANCELLED;
  }
}
