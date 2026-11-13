/**
 * VTID-05657 — pure request classifier for the native-app adoption measurement.
 *
 * `X-Vitana-Client: native/<ios|android|test>/<version>` → 'native'; anything else
 * (missing, malformed, unknown platform, unparseable version) → 'web'.
 * No I/O, no Express import. The middleware and storage live in lane client-identity-store.
 */

export type ClientClass = 'native' | 'web';

export const CLIENT_HEADER = 'X-Vitana-Client';

const NATIVE_HEADER = /^native\/(ios|android|test)\/([0-9A-Za-z][0-9A-Za-z.+_-]{0,31})$/;

export function classifyClient(headerValue: string | string[] | null | undefined): ClientClass {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== 'string' || value.length > 64) return 'web';
  return NATIVE_HEADER.test(value) ? 'native' : 'web';
}
