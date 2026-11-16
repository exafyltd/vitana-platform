// Local test resolver: lets Node run the gateway's extensionless TypeScript imports directly
// (node --import ./resolve-ts.mjs --experimental-strip-types --test ...). The gateway itself is compiled
// by tsc / ts-jest; this file is only for running the mr-review tests without installing gateway deps.
import { register } from 'node:module';
register(new URL('./resolve-ts-hooks.mjs', import.meta.url));
