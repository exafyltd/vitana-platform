import sys
base={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')}
tgt={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[2]) if '|' in l}
# Expected values after a schema-only restore (auth-scope rules, VTID-05803):
#  - fk_to_auth: only the public-schema constraints are restored, so the target count equals the source's
#    fk_public_to_auth (the 10 auth->auth constraints belong to Supabase Auth tables and are not restored).
#  - fk_constraints, fk_public_to_auth: all public foreign keys are restored, so they equal the source baseline.
#  - public_rows_estimate: 0 (no member data is copied).
expected={'fk_to_auth':base['fk_public_to_auth'],'public_rows_estimate':'0'}
bad=[]
for k in base:
    t=tgt.get(k); want=expected.get(k,base[k])
    if t==want and k in expected:
        status='EXPECTED (auth-scope)' if k=='fk_to_auth' else 'EXPECTED (no member data)'
    elif t==want:
        status='MATCH'
    else:
        status='MISMATCH'; bad.append(k)
    print(f"{k:24s} source={base[k]:>10s} staging={str(t):>10s} {status}")
print('unexplained mismatches:', bad or 'none')
sys.exit(1 if bad else 0)
