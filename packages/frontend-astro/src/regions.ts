/**
 * @domflax/frontend-astro — the region model for a `.astro` file.
 *
 * An Astro component is TWO regions:
 *
 *   • FRONTMATTER — the `---` … `---` fenced block at the top. JavaScript/TypeScript, preserved
 *     VERBATIM and never parsed or represented in the IR: no node covers its bytes, so the surgical
 *     backend can never touch them (exactly how the HTML frontend treats the doctype).
 *   • TEMPLATE — everything after the closing fence (or the whole file when there is no
 *     frontmatter). Parsed with parse5 in FRAGMENT mode; every parse5 offset is relative to this
 *     region, so `templateStart` is added to every recorded span.
 *
 * Both helpers here are pure string classification — no parse5, no IR.
 */

/** Where the template region begins, and whether the frontmatter (if any) was well-formed. */
export interface AstroSplit {
  /** false → malformed frontmatter (unterminated fence): the WHOLE file must pass through opaque. */
  readonly ok: boolean;
  readonly hasFrontmatter: boolean;
  /** Absolute offset in the full source where the TEMPLATE region begins (0 without frontmatter). */
  readonly templateStart: number;
}

/**
 * Split a `.astro` source into frontmatter + template. The opening fence is a `---` line at the top
 * of the file (an optional BOM / blank lines before it are tolerated); the closing fence is the next
 * line that is exactly `---` (trailing spaces allowed). A `---` line inside a frontmatter string
 * literal would end the region early — the template parse of leftover JS produces no editable
 * elements, so the mistake stays byte-preserving; an UNTERMINATED fence is reported as `ok: false`
 * and the caller passes the whole file through untouched.
 */
export function splitAstro(code: string): AstroSplit {
  const open = /^\uFEFF?[ \t\r\n]*---[ \t]*(?:\r?\n|$)/.exec(code);
  if (!open) return { ok: true, hasFrontmatter: false, templateStart: 0 };

  const afterOpen = open[0].length;
  const close = /^---[ \t]*\r?$/gm;
  close.lastIndex = afterOpen;
  const m = close.exec(code);
  if (!m) return { ok: false, hasFrontmatter: true, templateStart: code.length };

  let end = m.index + m[0].length;
  if (code[end] === '\n') end += 1; // consume the newline terminating the fence line
  return { ok: true, hasFrontmatter: true, templateStart: end };
}

/**
 * Does the file contain ANY `<style>` block? Astro styles are SCOPED by default: the compiler
 * rewrites their selectors against the component's exact element structure, so flattening a wrapper
 * or rewriting a class list can silently detach rules. When this returns true the ENTIRE component
 * passes through unchanged (whole-file scan on purpose — a `<style` anywhere, even in a spot we
 * misclassify, must fail toward "preserve").
 */
export function hasStyleBlock(code: string): boolean {
  return /<style[\s>/]/i.test(code);
}
