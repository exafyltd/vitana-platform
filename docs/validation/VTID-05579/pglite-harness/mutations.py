# Applies each mutation to the lane migrations in place, runs lane.sh, records the red lines, restores the file.
# Usage: python3 mutations.py   (writes ../outputs/mutations.txt). Local PGlite evidence only.
import subprocess, os
H = os.path.dirname(os.path.abspath(__file__))
R = os.path.abspath(os.path.join(H, '../../../..'))
M = R + '/supabase/migrations/'
F0 = M + '20261102054000_vtid_05579_chat_groups_scope.sql'
F1 = M + '20261102054100_vtid_05579_network_group_rpcs.sql'
F2 = M + '20261102054200_vtid_05579_chat_groups_rls.sql'
muts = [
 ('M1 cap 20 -> 21 in the function AND the table guard', [(F1, "m.group_id = p_group) >= 20", "m.group_id = p_group) >= 21"), (F0, "m.group_id = NEW.group_id) >= 20", "m.group_id = NEW.group_id) >= 21")]),
 ('M2 cap removed from the table guard only (the function still refuses)', [(F0, "m.group_id = NEW.group_id) >= 20", "m.group_id = NEW.group_id) >= 2000")]),
 ('M3 connection rule removed', [(F1, "  IF NOT EXISTS (SELECT 1 FROM public.connection_requests c", "  IF false AND NOT EXISTS (SELECT 1 FROM public.connection_requests c")]),
 ('M4 admin-only invite removed', [(F1, "IF v_role <> 'admin' THEN", "IF false THEN")]),
 ('M5 rule 43-45 check removed from the table guard only', [(F0, "IF public.is_network_excluded_account(NEW.user_id) THEN", "IF false THEN")]),
 ('M6 rule 43-45 check removed from the add function AND the table guard', [(F1, "  IF public.is_network_excluded_account(p_user) THEN", "  IF false THEN"), (F0, "IF public.is_network_excluded_account(NEW.user_id) THEN", "IF false THEN")]),
 ('M7 legacy backfill removed', [(F0, " WHERE scope = 'community' AND metadata ->> 'legacy_scope' = 'network';", " WHERE false;")]),
 ('M8 groups scope guard lets a direct network write through', [(F0, "RAISE EXCEPTION 'chat_groups.scope is written only by create_network_group()' USING ERRCODE = '42501';", "NULL;")]),
 ('M9 network_not_system CHECK removed', [(F0, "CHECK (scope = 'community' OR is_system = false)", "CHECK (true)")]),
 ('M10 member scope no longer forced to the group scope', [(F0, "  NEW.scope := v_scope;\n", "")]),
 ('M11 member row takes the invitee tenant instead of the creator tenant', [(F1, "VALUES (p_group, p_user, v_g.tenant_id, 'member', 'network')", "VALUES (p_group, p_user, coalesce((SELECT tenant_id FROM public.user_tenants WHERE user_id = p_user LIMIT 1), v_g.tenant_id), 'member', 'network')")]),
 ('M12 platform tenant allowed as context tenant', [(F1, "     AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = ut.tenant_id AND t.is_platform)\n   ORDER BY ut.is_primary DESC", "   ORDER BY ut.is_primary DESC")]),
 ('M13 block check removed', [(F1, "  IF EXISTS (SELECT 1 FROM public.user_blocklist b", "  IF false AND EXISTS (SELECT 1 FROM public.user_blocklist b")]),
 ('M14 read policies back to the per-row auth.uid() form', [(F2, "(SELECT auth.uid())))", "auth.uid()))")]),
 ('M15 an allow-all FOR ALL policy for authenticated is added (assertion removed)', [(F2, "IF EXISTS (SELECT 1 FROM pg_policies", "CREATE POLICY zz_allow_all ON public.chat_groups FOR ALL TO authenticated USING (true) WITH CHECK (true);\n  IF false AND EXISTS (SELECT 1 FROM pg_policies")]),
 ('M16 non-network groups no longer refused (the community client write path of the review)', [(F1, "IF v_g.scope IS DISTINCT FROM 'network' THEN", "IF false THEN")]),
 ('M17 add_group_member_as executable by authenticated', [(F1, "GRANT EXECUTE ON FUNCTION public.add_group_member_as(uuid, uuid, uuid) TO service_role;", "GRANT EXECUTE ON FUNCTION public.add_group_member_as(uuid, uuid, uuid) TO service_role, authenticated;")]),
]
out = []
for name, edits in muts:
    bak = {}
    for f, o, n in edits:
        s = open(f).read()
        bak.setdefault(f, s)
        assert o in s, (name, o)
        open(f, 'w').write(s.replace(o, n, 1))
    try:
        p = subprocess.run([H + '/lane.sh'], capture_output=True, text=True)
    finally:
        for f, s in bak.items(): open(f, 'w').write(s)
    txt = p.stdout + p.stderr
    nots = [l[:150] for l in txt.splitlines() if l.startswith('not ok') or 'SQL ERROR' in l or 'FAILED loading' in l]
    out.append(f"### {name}  [exit {p.returncode}]")
    out += nots[:6]
    if len(nots) > 6: out.append(f"... {len(nots)} red lines in total")
    if p.returncode == 0: out.append('!!! NOT DETECTED')
p = subprocess.run([H + '/lane.sh'], capture_output=True, text=True)
out.append(f"### restored: exit {p.returncode}, {sum(1 for l in p.stdout.splitlines() if l.startswith('ok'))} ok")
open(R + '/docs/validation/VTID-05579/outputs/mutations.txt', 'w').write('\n'.join(out) + '\n')
print('\n'.join(l for l in out if 'NOT DETECTED' in l or l.startswith('### restored')))
