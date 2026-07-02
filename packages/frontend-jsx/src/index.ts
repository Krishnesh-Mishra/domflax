/**
 * @domflax/frontend-jsx — Babel JSX ⇄ IR frontend + backend (TYPED STUB, Stage 1).
 *
 * Public surface:
 *   • {@link jsxFrontend} / {@link createJsxFrontend} — Frontend (JSX/TSX → IR).
 *   • {@link jsxBackend}  / {@link createJsxBackend}  — Backend  (IR → JSX/TSX).
 *
 * Both define the SHAPE only: `parse`/`print` throw NotImplemented; the cheap
 * routing predicates (`canParse`, `langs`, `name`) are real.
 */

export { jsxFrontend, createJsxFrontend } from './frontend';
export { jsxBackend, createJsxBackend } from './backend';
export { DEFAULT_CLASS_CALLEES } from './frontend-classlist';
