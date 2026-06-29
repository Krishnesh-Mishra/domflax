/**
 * `domflax/verify` — standalone equivalence checker.
 *
 * Subpath export of the bundled (private) `@domflax/verify`: render before/after and prove the UI
 * is identical (pixel + bounding-box + computed-style diff across viewports). Usable in CI without
 * the build plugin. Playwright is an optional peer pulled only by this entry.
 */
export * from '@domflax/verify';
