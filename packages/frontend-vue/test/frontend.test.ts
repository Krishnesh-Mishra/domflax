/**
 * @domflax/frontend-vue — frontend/backend suite.
 *
 * Full-pipeline tests (parse → provably-safe passes → reverse-emit → surgical print) over `.vue`
 * SFCs, with self-contained stub resolvers (see ./harness). Pins the frontend's contract:
 * byte-identical round-trips, template-only optimization, conservative opacity for everything
 * Vue-reactive, whole-file passthrough for any `<style>` block, and graceful degradation when the
 * optional `@vue/compiler-sfc` peer is missing.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createNullResolver } from '@domflax/core';

import { __setCompilerSfcLoaderForTests, createVueFrontend, vueFrontend } from '../src/index';
import { optimizeVue, paddingResolver, parseVue, resolvedEmptyResolver } from './harness';

const SCRIPT = `<script setup lang="ts">
import { ref } from 'vue';
const msg = ref('hi');
const ok = ref(true);
</script>`;

/* ───────────────────────── round-trip (byte-for-byte) ───────────────────────── */

const FULL_SFC = `${SCRIPT}

<template>
  <div class="wrap">
    <p>Plain paragraph with   irregular    whitespace.</p>
    <!-- a comment: keep me verbatim -->
    <button @click="ok = !ok" class="btn">{{ msg }}</button>
  </div>
</template>

<style scoped>
.wrap { color: red; }
</style>
`;

describe('vue frontend/backend — round-trip', () => {
  it('returns a full SFC (script setup + template + style) BYTE-FOR-BYTE unchanged', () => {
    // <style scoped> present ⇒ whole-file passthrough, whatever the resolver could do.
    expect(optimizeVue(FULL_SFC, paddingResolver())).toBe(FULL_SFC);
    expect(optimizeVue(FULL_SFC, createNullResolver())).toBe(FULL_SFC);
  });

  it('returns a style-less SFC with no optimizable content byte-for-byte unchanged', () => {
    const src = `${SCRIPT}

<template>
  <div class="wrap">
    <p>Text with   spaces.</p>
    <!-- keep me -->
  </div>
</template>
`;
    // Null resolver ⇒ nothing resolves ⇒ no compress/flatten ⇒ pure passthrough through the REAL
    // template-lowering path (not the style-block passthrough).
    expect(optimizeVue(src, createNullResolver())).toBe(src);
  });
});

/* ───────────────────────── inert flatten + compress (stub resolvers) ───────────────────────── */

describe('vue frontend/backend — flatten + compress inside <template>', () => {
  it('unwraps an inert wrapper (resolved-to-no-paint class), keeping the child verbatim', () => {
    const src = `${SCRIPT}

<template><div class="wrapper"><a class="link" href="/x">L</a></div></template>
`;
    const out = optimizeVue(src, resolvedEmptyResolver());
    expect(out).not.toContain('class="wrapper"');
    expect(out).toContain('<a class="link" href="/x">L</a>');
    // Script block + template tags stay byte-identical.
    expect(out).toContain(SCRIPT);
    expect(out).toContain('<template>');
    expect(out).toContain('</template>');
  });

  it('compresses a static class list in place (px-4 py-4 → p-4), all other bytes verbatim', () => {
    const src = `${SCRIPT}

<template>
  <section class="px-4 py-4">Body</section>
</template>
`;
    const out = optimizeVue(src, paddingResolver());
    expect(out).toBe(src.replace('class="px-4 py-4"', 'class="p-4"'));
  });
});

/* ───────────────────────── conservative opacity — Vue syntax is never touched ───────────────────────── */

describe('vue frontend/backend — opacity (directives / components / interpolation)', () => {
  const opt = (template: string): { src: string; out: string } => {
    const src = `${SCRIPT}

<template>
${template}
</template>
`;
    return { src, out: optimizeVue(src, paddingResolver()) };
  };

  it('v-if stays untouched (compressible class preserved verbatim)', () => {
    const { src, out } = opt('  <p v-if="ok" class="px-4 py-4">c</p>');
    expect(out).toBe(src);
  });

  it('v-for stays untouched', () => {
    const { src, out } = opt('  <li v-for="i in [1, 2]" :key="i" class="px-4 py-4">{{ i }}</li>');
    expect(out).toBe(src);
  });

  it(':class / dynamic bindings stay untouched', () => {
    const { src, out } = opt('  <span :class="msg" class="px-4 py-4">dyn</span>');
    expect(out).toBe(src);
  });

  it('component tags, <slot>, and nested <template> stay untouched', () => {
    const { src, out } = opt(
      [
        '  <MyComp class="px-4 py-4"><em class="px-4 py-4">inside</em></MyComp>',
        '  <slot name="s"></slot>',
        '  <template #footer><b class="px-4 py-4">f</b></template>',
      ].join('\n'),
    );
    expect(out).toBe(src);
  });

  it('{{ interpolation }} is preserved and blocks flattening its parent', () => {
    // The wrapper's class resolves to nothing (inert-looking), but the interpolation child makes it
    // dynamic — the wrapper must NOT be unwrapped.
    const src = `${SCRIPT}

<template><div class="wrapper">{{ msg }}</div></template>
`;
    expect(optimizeVue(src, resolvedEmptyResolver())).toBe(src);
  });

  it('id / inline handler / ref / key pin the element (never rewritten)', () => {
    const { src, out } = opt(
      [
        '  <div id="keep" class="px-4 py-4">a</div>',
        '  <div onclick="go()" class="px-4 py-4">b</div>',
        '  <div ref="node" class="px-4 py-4">c</div>',
      ].join('\n'),
    );
    expect(out).toBe(src);
  });
});

/* ───────────────────────── <style> blocks ⇒ whole-file passthrough ───────────────────────── */

describe('vue frontend/backend — <style> blocks force passthrough', () => {
  const TEMPLATE = '<template><div class="wrapper"><section class="px-4 py-4">x</section></div></template>';

  it('<style scoped> ⇒ the whole file is untouched (even with flatten/compress opportunities)', () => {
    const src = `${TEMPLATE}\n<style scoped>\n.a { color: red; }\n</style>\n`;
    expect(optimizeVue(src, paddingResolver())).toBe(src);
    expect(optimizeVue(src, resolvedEmptyResolver())).toBe(src);
  });

  it('<style module> ⇒ untouched', () => {
    const src = `${TEMPLATE}\n<style module>\n.a { color: red; }\n</style>\n`;
    expect(optimizeVue(src, paddingResolver())).toBe(src);
  });

  it('plain <style> ⇒ untouched (conservative)', () => {
    const src = `${TEMPLATE}\n<style>\n.a { color: red; }\n</style>\n`;
    expect(optimizeVue(src, paddingResolver())).toBe(src);
  });
});

/* ───────────────────────── script/style byte-preservation in edited files ───────────────────────── */

describe('vue frontend/backend — non-template blocks are byte-identical in EDITED output', () => {
  it('an edited template never disturbs the <script> block bytes', () => {
    const gnarly = `<script>
export default {
  data: () => ({ s: "<div class=\\"px-4 py-4\\">not a template</div>", n: 1 < 2 && 3 > 1 })
}
</script>`;
    const src = `${gnarly}

<template>
  <section class="px-4 py-4">Body</section>
</template>
`;
    const out = optimizeVue(src, paddingResolver());
    expect(out).toContain(gnarly); // script block byte-identical
    expect(out).toContain('class="p-4"'); // …while the template was actually edited
  });
});

/* ───────────────────────── missing optional peer ⇒ graceful degradation ───────────────────────── */

describe('vue frontend — @vue/compiler-sfc unavailable', () => {
  afterEach(() => __setCompilerSfcLoaderForTests(null));

  it('canParse is false and parse degrades to a byte-identical passthrough (no throw)', () => {
    __setCompilerSfcLoaderForTests(() => {
      throw new Error("Cannot find module '@vue/compiler-sfc'");
    });

    expect(vueFrontend.canParse('App.vue', FULL_SFC)).toBe(false);

    const compressible = `<template><section class="px-4 py-4">Body</section></template>\n`;
    expect(() => parseVue(compressible, paddingResolver())).not.toThrow();
    expect(optimizeVue(compressible, paddingResolver())).toBe(compressible);
  });

  it('recovers once the loader works again', () => {
    __setCompilerSfcLoaderForTests(() => {
      throw new Error('nope');
    });
    expect(vueFrontend.canParse('App.vue', FULL_SFC)).toBe(false);

    __setCompilerSfcLoaderForTests(null);
    expect(createVueFrontend().canParse('App.vue', FULL_SFC)).toBe(true);
  });
});

/* ───────────────────────── canParse ownership ───────────────────────── */

describe('vue frontend — canParse', () => {
  it('claims only .vue ids', () => {
    expect(vueFrontend.canParse('src/App.vue', '<template/>')).toBe(true);
    expect(vueFrontend.canParse('src/App.vue?vue&type=template', '<template/>')).toBe(true);
    expect(vueFrontend.canParse('index.html', '<!doctype html>')).toBe(false);
    expect(vueFrontend.canParse('A.tsx', 'export default 1')).toBe(false);
  });
});
