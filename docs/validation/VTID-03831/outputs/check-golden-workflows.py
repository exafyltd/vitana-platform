#!/usr/bin/env python3
"""VTID-03831 evidence: cross-check GOLDEN-WORKFLOWS.md against the pinned ERPClaw catalogs."""
import re, sys, subprocess
DOC='/home/user/vitana-platform/docs/backoffice/GOLDEN-WORKFLOWS.md'
CORE='/home/user/avansaber/erpclaw/SKILL.md'
CRM='/home/user/avansaber/erpclaw-addons/erpclaw-growth/SKILL.md'
ROUTER='/home/user/avansaber/erpclaw/scripts/db_query.py'
def sha(p): return subprocess.check_output(['git','-C',p,'rev-parse','HEAD']).decode().strip()
print('erpclaw       HEAD', sha('/home/user/avansaber/erpclaw'))
print('erpclaw-addons HEAD', sha('/home/user/avansaber/erpclaw-addons'))
doc=open(DOC).read()
core=open(CORE).read(); crm=open(CRM).read()
catalog=set(re.findall(r'`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`', core)) | set(re.findall(r'`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`', crm))
# wildcard families used in the denylist
families=('-fica-','-futa-suta-')
fails=0
# 1. Every kebab-case token in the doc that looks like an ERPClaw action must exist in a catalog.
tokens=sorted(set(re.findall(r'`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`', doc)))
non_actions={'us-gaap','uae-ifrs','erpclaw-growth','erpclaw-addons','erpclaw-tax','erpclaw-gl','erpclaw-web','erpclaw-approvals','user-confirmed','maker-checker','tenant-admin','order-to-cash','add-payment'}
missing=[]
for t in tokens:
    if t in catalog: continue
    if any(f in t for f in families): continue
    if t.startswith('*-') or t.startswith('--'): continue
    if t in ('is_return',): continue
    if '.' in t or '_' in t: continue
    if t in non_actions or t.startswith('erpclaw-') or t.startswith('vitana-') or t.startswith('VTID'): continue
    missing.append(t)
print(f'\n[1] ERPClaw action names cited in the doc: {len([t for t in tokens if t in catalog])} resolve against the pinned catalogs')
if missing:
    fails+=1; print('    FAIL — not found in either catalog:', missing)
else:
    print('    PASS — no cited action is absent from the pinned catalogs')
# 2. Every action the doc marks "(ERPClaw-gated)" or "(gated)" must be in DANGEROUS_ACTIONS; and every DANGEROUS action the doc exposes must be Commit/High-risk.
router=open(ROUTER).read()
m=re.search(r'DANGEROUS_ACTIONS = frozenset\(\{(.*?)\}\)', router, re.S)
dangerous=set(re.findall(r'"([a-z0-9\-]+)"', m.group(1)))
print(f'\n[2] DANGEROUS_ACTIONS at pinned commit: {len(dangerous)} actions')
gated_claims=set()
for line in doc.splitlines():
    if 'ERPClaw-gated' in line or '(gated)' in line:
        for a in re.findall(r'`([a-z0-9\-]+)`', line.split('|')[1] if line.startswith('|') else line):
            if a in catalog: gated_claims.add(a)
wrong=[a for a in sorted(gated_claims) if a not in dangerous]
print(f'    doc marks {len(gated_claims)} actions as ERPClaw-gated')
if wrong: fails+=1; print('    FAIL — marked gated but not in DANGEROUS_ACTIONS:', wrong)
else: print('    PASS — every action the doc marks gated is in DANGEROUS_ACTIONS')
# exposed dangerous actions must have Commit/High-risk tier in the same table row
bad_tier=[]
for line in doc.splitlines():
    if not line.startswith('| `'): continue
    cells=[c.strip() for c in line.strip('|').split('|')]
    if len(cells)<3: continue
    acts=[a for a in re.findall(r'`([a-z0-9\-]+)`', cells[0]) if a in dangerous]
    if not acts: continue
    tier=cells[2]
    if cells[1]=='—': continue  # not exposed
    if not ('Commit' in tier or 'High-risk' in tier): bad_tier.append((acts, tier))
if bad_tier: fails+=1; print('    FAIL — dangerous action exposed below Commit tier:', bad_tier)
else: print('    PASS — no DANGEROUS action is exposed at Read or Draft tier')
# 3. Golden workflow completeness
print('\n[3] Golden workflows')
for gw in ('GW-1','GW-2','GW-3','GW-4'):
    sec=re.search(rf'### {gw}(.*?)(?=\n### GW-|\n---)', doc, re.S).group(1)
    need={'Owner':'**Owner:**','Approver':'**Approver','Exception path':'**Exception path:**','Accounting result':'Accounting result','Acceptance test':'**Acceptance test'}
    miss=[k for k,v in need.items() if v not in sec]
    print(f'    {gw}: ' + ('PASS all five parts present' if not miss else f'FAIL missing {miss}'))
    if miss: fails+=1
# 4. Required top-level sections + UNASSIGNED items
print('\n[4] Structure')
for h in ('## 2. Golden workflows','## 3. Capability catalog','## 4. Wave-1 mapping','## 5. UAE','## 7. Open decisions'):
    ok=h in doc; print(f'    {"PASS" if ok else "FAIL"} section "{h}"'); fails+= (not ok)
rows=re.findall(r'^\| ([1-4]) \| \*\*(.+?)\*\*.*?\| \*\*UNASSIGNED\*\*', doc, re.M)
print(f'    {"PASS" if len(rows)==4 else "FAIL"} open-decision rows marked UNASSIGNED: {len(rows)}/4')
fails+= (len(rows)!=4)
# 5. Every wave-1 High-risk row names an approver capability
print('\n[5] High-risk rows in §4.2 name an approver')
hr_rows=[l for l in doc.splitlines() if l.startswith('| `') and '**High-risk**' in l]
noappr=[l[:60] for l in hr_rows if 'approver' not in l]
print(f'    {len(hr_rows)} High-risk mapping rows; ' + ('PASS all name an approver' if not noappr else f'FAIL {noappr}'))
fails+= bool(noappr)
print('\nRESULT:', 'PASS' if not fails else f'FAIL ({fails})')
sys.exit(1 if fails else 0)
