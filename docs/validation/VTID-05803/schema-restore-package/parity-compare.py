import sys
base={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')}
# Optional third file: objects the package adds itself (the staging outbox), added to the source baseline.
added={}
for l in (open(sys.argv[3]) if len(sys.argv)>3 else []):
    if '|' in l: k,v=l.strip().split('|')[:2]; added[k]=added.get(k,0)+int(v)
base={k:(str(int(v)+added.get(k,0)) if v.isdigit() else v) for k,v in base.items()}
tgt={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[2]) if '|' in l}
# Expected values after a schema-only restore (VTID-05803, owner decision R2):
#  - fk_public_to_auth, fk_to_auth: 0. public->auth.users FKs are excluded (empty auth.users stub; member inserts must
#    not fail), and the auth->auth.users FKs of the Supabase Auth tables are not restored.
#  - fk_constraints: every other public FK is restored, so source fk_constraints minus source fk_public_to_auth.
#  - public_rows_estimate: 0 (no member data is copied).
expected={'fk_to_auth':'0','fk_public_to_auth':'0',
          'fk_constraints':str(int(base['fk_constraints'])-int(base['fk_public_to_auth'])),'public_rows_estimate':'0'}
bad=[]
for k in base:
    t=tgt.get(k); want=expected.get(k,base[k])
    if k=='acl_entries':
        print(f"{k:24s} source={base[k]:>10s} staging={str(t):>10s} INFO (owner entries differ under --no-owner; acl_api_entries is the check)"); continue
    if t==want and k in expected:
        status='EXPECTED (no member data)' if k=='public_rows_estimate' else 'EXPECTED (R2 auth-scope)'
    elif t==want:
        status='MATCH'
    else:
        status='MISMATCH'; bad.append(k)
    print(f"{k:24s} source={base[k]:>10s} staging={str(t):>10s} {status}")
print('unexplained mismatches:', bad or 'none')
sys.exit(1 if bad else 0)
