import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[mc]?[jt]s$/.test(specifier) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier + '.ts', context.parentURL));
    if (existsSync(base)) return next(specifier + '.ts', context);
  }
  return next(specifier, context);
}
