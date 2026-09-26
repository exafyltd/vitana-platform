import { REDIRECT_MAP, SIGNED_OUT_REDIRECT_MAP } from '../../fixtures/routes';
import { createRedirectTests } from '../../fixtures/smoke-helper';

createRedirectTests('Desktop — Legacy Redirects', REDIRECT_MAP);
createRedirectTests('Desktop — Signed-out Redirects', SIGNED_OUT_REDIRECT_MAP, { signedOut: true });
