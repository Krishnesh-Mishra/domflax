import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectCssFiles, detectInputDirs } from '../src/detect';

describe('detect', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'domflax-detect-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const touch = (rel: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  };

  describe('detectCssFiles', () => {
    it('finds real .css files and excludes build/vendor dirs', () => {
      touch('styles.css');
      touch('src/app.css');
      touch('src/components/button.css');
      // Excluded locations:
      touch('node_modules/pkg/dist.css');
      touch('dist/bundle.css');
      touch('build/out.css');
      touch('.next/static.css');
      touch('out/page.css');
      touch('coverage/report.css');
      touch('domflax-out/result.css');
      // Non-css ignored:
      touch('src/index.tsx');

      expect(detectCssFiles(root)).toEqual(['src/app.css', 'src/components/button.css', 'styles.css']);
    });

    it('returns an empty list for a root with no CSS', () => {
      touch('src/index.tsx');
      expect(detectCssFiles(root)).toEqual([]);
    });

    it('returns an empty list (never throws) for a missing root', () => {
      expect(detectCssFiles(path.join(root, 'does-not-exist'))).toEqual([]);
    });

    it('scans an explicitly-given folder even when it is a build dir (e.g. dist)', () => {
      touch('dist/assets/site.css'); // skipped from the project root...
      touch('src/app.css');
      // From the root alone, dist is excluded:
      expect(detectCssFiles(root)).toEqual(['src/app.css']);
      // ...but given dist as an explicit scan root, its CSS is detected too (de-duped, sorted).
      expect(detectCssFiles(root, [path.join(root, 'dist')])).toEqual([
        'dist/assets/site.css',
        'src/app.css',
      ]);
    });

    it('descends only up to the requested depth', () => {
      touch('a/b/c/shallow.css'); // 3 levels deep
      touch('a/b/c/d/e/deep.css'); // 5 levels deep
      expect(detectCssFiles(root, [], 3)).toEqual(['a/b/c/shallow.css']);
    });
  });

  describe('detectInputDirs', () => {
    it('returns only the common source dirs that exist, in suggestion order', () => {
      mkdirSync(path.join(root, 'src'));
      mkdirSync(path.join(root, 'components'));
      mkdirSync(path.join(root, 'public'));
      // A non-common dir is ignored; a file named like a common dir is not a dir.
      mkdirSync(path.join(root, 'scripts'));
      writeFileSync(path.join(root, 'lib'), '', 'utf8');

      expect(detectInputDirs(root)).toEqual(['src', 'components', 'public']);
    });

    it('returns an empty list when none of the common dirs exist', () => {
      mkdirSync(path.join(root, 'scripts'));
      expect(detectInputDirs(root)).toEqual([]);
    });
  });
});
