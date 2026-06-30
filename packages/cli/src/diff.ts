/**
 * @domflax/cli — a tiny, dependency-free unified-ish diff for `--dry-run` previews.
 *
 * Trims the common leading/trailing lines and prints the differing middle as `-old` / `+new`. This is
 * a readable preview, not a minimal edit script (the backend re-prints rather than splices).
 */

export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return `  (unchanged) ${label}`;

  const a = before.split('\n');
  const b = after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);

  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  if (prefix > 0) lines.push(`@@ -${prefix + 1} +${prefix + 1} @@`);
  for (const r of removed) lines.push(`-${r}`);
  for (const ad of added) lines.push(`+${ad}`);
  return lines.join('\n');
}
