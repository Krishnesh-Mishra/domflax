#!/usr/bin/env node
/**
 * `domflax` CLI bin entry.
 *
 * Thin wrapper over the bundled (private) `@domflax/cli` `main()`. Invoked as `npx domflax …`.
 */
import { main } from '@domflax/cli';

main(process.argv.slice(2));
