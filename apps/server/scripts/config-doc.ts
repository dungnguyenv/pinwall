/** Writes docs/configuration.md from the catalog. Run it with `pnpm docs:config`. */
import { writeFileSync } from 'node:fs';
import { CONFIG_VARS, renderConfigurationDoc } from '../src/config/catalog.ts';

const target = new URL('../../../docs/configuration.md', import.meta.url);
writeFileSync(target, renderConfigurationDoc(CONFIG_VARS));
console.log(`wrote ${target.pathname}`);
