/**
 * The conservative DOM pass: remove provably inert wrappers, nothing else.
 *
 * Rule set (deliberately tiny — when unsure, leave the tree alone):
 *  1. `<div>`/`<span>` with NO attributes at all, wrapping exactly one child
 *     node that is an element (no text/comment siblings) → hoist the child.
 *  2. `<div>`/`<span>` whose ONLY attribute is `style` and whose style is a
 *     single `display: contents` declaration → same hoist.
 *
 * Never descended into: script, style, template, pre, textarea, any non-HTML
 * namespace (svg/mathml), and any element carrying an event-ish `on*`
 * attribute. Elements with any other attribute/id/class are never removed —
 * a class may carry styles we cannot know about without the page's CSS.
 */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'PRE', 'TEXTAREA']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ELEMENT_NODE = 1;

/** True when the style attribute is exactly one `display: contents` declaration. */
function isDisplayContentsOnly(style: string): boolean {
  const decls = style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  if (decls.length !== 1) return false;
  const colon = decls[0].indexOf(':');
  if (colon < 0) return false;
  const prop = decls[0].slice(0, colon).trim().toLowerCase();
  const value = decls[0].slice(colon + 1).trim().toLowerCase();
  return prop === 'display' && value === 'contents';
}

/** Subtrees we must never look inside, let alone mutate. */
function shouldSkipSubtree(el: Element): boolean {
  if (el.namespaceURI !== HTML_NS) return true; // svg, mathml, anything foreign
  if (SKIP_TAGS.has(el.tagName)) return true;
  for (let i = 0; i < el.attributes.length; i++) {
    if (el.attributes[i].name.toLowerCase().startsWith('on')) return true;
  }
  return false;
}

/** Is this element a wrapper we can prove inert and safe to unwrap? */
function isRemovableWrapper(el: Element): boolean {
  const tag = el.tagName;
  if (tag !== 'DIV' && tag !== 'SPAN') return false;

  const attrs = el.attributes;
  if (attrs.length === 1) {
    const attr = attrs[0];
    if (attr.name !== 'style' || !isDisplayContentsOnly(attr.value)) return false;
  } else if (attrs.length !== 0) {
    return false;
  }

  // Exactly one child node, and it must be an element — any text or comment
  // sibling means removing the wrapper could change rendering or meaning.
  if (el.childNodes.length !== 1) return false;
  const child = el.childNodes[0];
  if (child.nodeType !== ELEMENT_NODE) return false;

  // Never even relocate a protected subtree (script/style/svg/…): leave the
  // wrapper alone rather than hoist a child we refuse to reason about.
  return !shouldSkipSubtree(child as Element);
}

/**
 * Bottom-up pass over the parsed body. Mutates in place.
 * Returns true when at least one wrapper was removed.
 */
export function optimizeBody(body: Element): boolean {
  // A <style> block anywhere in the fragment can carry selectors that depend on
  // the structure we would remove (`div > p { … }`). The runtime has no CSS
  // awareness, so the only safe move is to change nothing at all.
  if (body.querySelector('style') !== null) return false;

  let changed = false;

  const visit = (el: Element): void => {
    if (shouldSkipSubtree(el)) return;

    // Children first (snapshot: unwrapping mutates child lists as we go).
    const children = Array.from(el.children);
    for (const child of children) visit(child);

    if (isRemovableWrapper(el) && el.parentNode) {
      el.parentNode.replaceChild(el.childNodes[0], el);
      changed = true;
    }
  };

  for (const child of Array.from(body.children)) visit(child);
  return changed;
}
