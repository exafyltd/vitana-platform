import sys
base={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith('#')}
tgt={l.split('|')[0]:l.split('|')[1].strip() for l in open(sys.argv[2]) if '|' in l}
expected={'fk_to_auth':'0','fk_constraints':str(int(base['fk_constraints'])-int(base['fk_public_to_auth'])),'public_rows_estimate':'0','fk_public_to_auth':'0'}
bad=[]
for k in base:
    t=tgt.get(k); want=expected.get(k,base[k])
    if t==want and k in expected:
        status='EXPECTED (auth-scope)' if k!='public_rows_estimate' else 'EXPECTED (no member data)'
    elif t==want:
        status='MATCH'
    else:
        status='MISMATCH'; bad.append(k)
    print(f"{k:24s} source={base[k]:>10s} staging={str(t):>10s} {status}")
print('unexplained mismatches:', bad or 'none')
sys.exit(1 if bad else 0)
