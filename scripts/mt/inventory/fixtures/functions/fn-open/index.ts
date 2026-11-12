const auth = req.headers.get('Authorization');
const c = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
