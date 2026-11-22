// Renders an nginx template the way the proxy image does at container start: envsubst with the allowlist
// '$${SUPABASE_AUTH_HOST} $${PUBLIC_HOST}' from the Dockerfile CMD. Only allowlisted names are replaced. An unset or
// empty value becomes an empty string. Every other $ sequence stays as written, including nginx variables such as
// $uri, $1 and $http_upgrade. The route tests check this rendered text, because nginx reads the rendered file.
export const ALLOWLIST = Object.freeze(['SUPABASE_AUTH_HOST', 'PUBLIC_HOST']);

export function render(template, env = {}, allowlist = ALLOWLIST) {
  return template.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) => {
    const name = braced ?? bare;
    if (!allowlist.includes(name)) return match;
    return env[name] ?? '';
  });
}
