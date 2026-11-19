import fnmatch as F,hashlib as H,json,os,re,socket,subprocess as S,sys,tarfile,time,urllib.parse as U
W=os.environ.get("K5_W","/w");O=W+"/out";os.makedirs(O,exist_ok=True);E=os.environ.get;HIDE=[];RUN=E("K5_RUN","local");DATA=E("K5_DATA","schema-only")
R={"vtid":"VTID-05803","run":RUN,"data_mode":DATA,"commit":E("K5_COMMIT",""),"steps":{}}
def red(s):
 s=re.sub(r"postgres(ql)?://\S+","<uri>",str(s))
 for h in HIDE:
  if h:s=s.replace(h,"***")
 return s
def log(m):
 m=red(m);print("K5 "+m,flush=True);open(O+"/run.log","a").write(m+"\n")
def done(c,why="",d=2):
 R.update(diag=d if c in(1,2)else c,exit_code=c,result={0:"ACCEPTED",1:"REJECTED"}.get(c,"ERROR"),reason=red(why),finished=time.strftime("%FT%TZ",time.gmtime()))
 open(O+"/report.json","w").write(json.dumps(R,indent=1,sort_keys=True));dst=E("K5_OUT","")
 if dst:
  p=S.run(["aws","s3","cp","--recursive","--only-show-errors",O,dst.rstrip("/")+"/"],capture_output=True,text=True);R["upload"]="ok" if p.returncode==0 else "failed"
  if p.returncode:log("upload failed "+p.stderr[-200:]);d=80 if c==0 else d+100 if c==1 else d;c=c or 2
 R["exit_code"]=c;R["diag"]=d if c in(1,2)else c;R["result"]={0:"ACCEPTED",1:"REJECTED"}.get(c,"ERROR");log("REPORT "+json.dumps(R,sort_keys=True));log(f"RESULT {R['result']} exit={c} diag={R['diag']}");sys.exit(R["diag"])
def env(h,p,u,w,d):
 HIDE.append(w);e={k:v for k,v in os.environ.items() if not k.startswith(("PG","SOURCE_URI"))}
 e.update(PGHOST=h,PGPORT=str(p),PGUSER=u,PGPASSWORD=w,PGDATABASE=d,PGSSLMODE=E("K5_SSLMODE","require"),PGCONNECT_TIMEOUT="20",PGAPPNAME="vtid-05803-k5",PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=900000");return e
def q(e,a,f):
 p=S.run(["psql","-X","-q","-At","-v","ON_ERROR_STOP=1","-c","SET SESSION default_transaction_read_only = on"]+a,env=e,capture_output=True,text=True);open(f,"w").write(p.stdout);open(f+".err","w").write(red(p.stderr));return p.returncode,red(p.stderr.strip())[-300:]
def cls(e):
 e=e.lower()
 return 1 if"password authentication failed"in e or"authentication failed"in e else 4 if"does not exist"in e else 3 if"ssl"in e else 2 if any(x in e for x in("timeout","could not connect","unreachable","refused","could not translate","no route"))else 0
def tcp(h,p):
 for fam in(socket.AF_INET,socket.AF_INET6):
  try:
   for a in{x[4][0]for x in socket.getaddrinfo(h,p,fam)}:
    try:socket.create_connection((a,p),5).close();return 1
    except OSError:pass
  except OSError:pass
def rows(f,c=None):return[l for l in open(f).read().splitlines()if l and(c is None or l.startswith(c+"|"))]
def main():
 REF="inmkhvwdcuyhnxkgfvsb"
 try:
  r=re.sub(r"^postgres(ql)?://","",E("SOURCE_URI"));cr,_,hp=r.rpartition("@");su,_,sw=cr.partition(":");hp,_,pq=hp.partition("/");sd=pq.split("?")[0]or"postgres"
  sh,_,sp=hp.rpartition(":")if hp.count(":")==1 else(hp,"","");sp=int(sp or 5432);RAW=sw;su,sw=U.unquote(su),U.unquote(sw);HIDE.append(RAW)
  assert sh and su and sw
 except Exception as x:done(2,"SOURCE_URI missing or unparsable "+type(x).__name__,30)
 HIDE.append(sw)
 T=E("K5_TEST")=="1"and sh=="127.0.0.1"
 if not T and not(sh==f"db.{REF}.supabase.co"or sh.endswith(".pooler.supabase.com")):done(2,f"source host {sh} is not the Supabase project",31)
 if not T and not tcp(sh,sp):
  if sh!=f"db.{REF}.supabase.co":done(2,f"source {sh}:{sp} unreachable",32)
  sh,sp,su=E("POOLER_HOST","aws-1-eu-north-1.pooler.supabase.com"),5432,"postgres."+REF;R["source_fallback"]=1;log(f"source fallback: session pooler {sh} as {su}")
 th=E("PGHOST","")
 if not(T and th=="127.0.0.1")and(not re.match(r"^vitana-aurora-staging[.-]",th)or"prod"in th):done(2,f"staging host {th!r} is not vitana-aurora-staging",33)
 X={"source":env(sh,sp,su,sw,sd),"staging":env(th,E("PGPORT","5432"),E("PGUSER",""),E("PGPASSWORD",""),E("K5_DB","vitana"))};R["steps"]["config"]="PASS"
 for s in X:
  for _ in(0,1):
   rc,er=q(X[s],["-c","select current_setting('server_version')||'|'||current_setting('transaction_read_only')||'|'||(select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in('r','p'))"],f"{O}/probe-{s}.txt")
   if not(rc and s=="source"and cls(er)==1 and RAW!=sw and X[s]["PGPASSWORD"]!=RAW):break
   X[s]["PGPASSWORD"]=RAW;log("source auth failed with the percent-decoded password; one retry with the stored value")
  if rc:R["steps"]["connect"]="FAIL";done(2,f"{s} connect: {er}",(40+cls(er)+(6 if R.get("source_fallback")and cls(er)in(1,2,3)else 0))if s=="source"else 50+cls(er))
  v,ro,n=open(f"{O}/probe-{s}.txt").read().strip().split("|");R[s]={"version":v,"read_only":ro,"public_tables":int(n)};log(f"{s} PG {v} read_only={ro} tables={n}")
  if ro!="on":done(2,s+" session not read-only",46 if s=="source"else 56)
 R["source_endpoint"]=f"{sh}:{sp}/{sd} user={su}";R["steps"]["connect"]="PASS";t=W+"/a.tgz";p=S.run(["aws","s3","cp","--only-show-errors",E("ACCEPT_S3_URI"),t],capture_output=True,text=True)if not os.path.isfile(t)else S.run(["true"],capture_output=True,text=True)
 if p.returncode or H.sha256(open(t,"rb").read()).hexdigest()!=E("ACCEPT_SHA256"):done(2,"acceptance package download/sha256 failed "+p.stderr[-150:],60)
 A=W+"/acc";tarfile.open(t).extractall(A)
 for l in open(A+"/SHA256SUMS"):
  h,f=l.split()
  if H.sha256(open(f"{A}/{f}","rb").read()).hexdigest()!=h:done(2,"checksum "+f,60)
 for s in X:
  for k,f in(("a07","A07-object-parity-suite.sql"),("a08","A08-rls-grants-extensions.sql")):
   rc,er=q(X[s],["-f",f"{A}/{f}"],f"{O}/{k}-{s}.txt")
   if rc:R["steps"]["catalog"]="FAIL";done(2,f"{k} {s}: {er}",61 if s=="source"else 62)
  log(f"{s} A07={len(rows(f'{O}/a07-{s}.txt'))} A08={len(rows(f'{O}/a08-{s}.txt'))}")
 R["steps"]["catalog"]="PASS";q(X["staging"],["-c","select rolname from pg_roles"],O+"/roles-staging.txt");have=set(rows(O+"/roles-staging.txt"));V={}
 ld=lambda f:{tuple(l.split("|",2)[:2]):l.split("|",2)[2]for l in rows(f)if l.count("|")>=2}
 src,stg=ld(O+"/a07-source.txt"),ld(O+"/a07-staging.txt");ow=[v[6:]for(c,_),v in stg.items()if c=="owner"];lo=max(set(ow),key=ow.count)if ow else"postgres"
 used={g for(c,n)in src if c in("grant","column_grant","function_grant")for g in[n.rsplit(".",2)[-2]]}|{r for(c,_),v in src.items()if c=="policy"for r in re.findall(r"roles=([^;]*)",v)[0].split(",")if r}
 ab=sorted(r for r in used if r not in have and r!="PUBLIC"and r!="public");mp={r:lo for r in{v[6:]for(c,_),v in src.items()if c=="owner"}if r!=lo and not r.startswith("pg_")}
 def m(c,n,v):
  if c in("grant","column_grant","function_grant"):o,g,pv=n.rsplit(".",2);n=f"{o}.{mp.get(g,g)}.{pv}"
  elif c=="owner":v="owner="+mp.get(v[6:],v[6:])
  elif c=="policy":v=re.sub(r"roles=([^;]*)",lambda x:"roles="+",".join(sorted({mp.get(r,r)for r in x.group(1).split(",")})),v)
  return(c,n),v
 src=dict(m(c,n,v)for(c,n),v in src.items())
 al=["auth_trigger|*|missing","function|notify_test_user_confirmation()|changed","function|notify_welcome_discount()|changed","ext_call|notify_test_user_confirmation()|any","ext_call|notify_welcome_discount()|any",f"grant|*.{lo}.*|missing",f"grant|*.{lo}.*|extra",f"function_grant|*.{lo}.*|any"]
 al+=[f"{c}|{g}|extra"for c,g in(("table","outbound_http_requests"),("column","outbound_http_requests.*"),("check","outbound_http_requests.*"),("primary_key","outbound_http_requests.*"),("index","outbound_http_requests*"),("sequence","outbound_http_requests*"),("function","outbound_http_*"),("function_grant","outbound_http_*"),("grant","outbound_http_requests*"),("owner","*outbound_http*"),("column_grant","outbound_http_requests.*"))]
 al+=[f"fk|{n}|missing"for(c,n),v in src.items()if c=="fk"and v.startswith("ref=auth.users;")]+[f"{c}|*.{r}.*|missing"for r in ab for c in("grant","column_grant","function_grant")]
 al+=[f"policy|{n}|missing"for(c,n),v in src.items()if c=="policy"and set(re.findall(r"roles=([^;]*)",v)[0].split(","))&set(ab)]
 if DATA=="full":al+=["table|awsdms_*|extra","column|awsdms_*|extra","grant|awsdms_*|extra","owner|*awsdms_*|extra","primary_key|awsdms_*|extra","index|awsdms_*|extra","sequence|awsdms_*|extra"]
 open(O+"/a07-allowlist-used.txt","w").write("\n".join(sorted(set(al)))+"\n");ok=lambda c,n,st:any(F.fnmatchcase(c,a.split("|")[0])and F.fnmatchcase(n,a.split("|")[1])and a.split("|")[2]in(st,"any")for a in al)
 un=[];st={}
 for k in sorted(set(src)|set(stg)):
  c,n=k
  if k in src and k in stg and src[k]==stg[k]:continue
  s="changed"if k in src and k in stg else"missing"if k in src else"extra";st[f"{c}:{s}"]=st.get(f"{c}:{s}",0)+1
  if not ok(c,n,s):un.append(f"{s} {c}|{n} source={src.get(k,'')[:120]} staging={stg.get(k,'')[:120]}")
 open(O+"/a07-diff.txt","w").write("\n".join(un)+"\n");V["A07"]=not un;R["a07"]={"source_rows":len(src),"staging_rows":len(stg),"loader":lo,"absent_roles":ab,"differences":st,"unexplained":len(un),"sample":un[:40]}
 log(f"A07 {'PASS'if V['A07']else'FAIL'} unexplained={len(un)} {json.dumps(st,sort_keys=True)[:600]}")
 sk=re.compile("|".join(map(re.escape,ab+["outbound_http"])));nm=lambda l:re.sub(r"\b(extensions|public)\.(vector|halfvec|sparsevec)\b",r"\2",l);a8={}
 for c in("rls","policy","table_grant","column_grant","sequence_grant","function_grant","extension"):
  a,b=({nm(l)for l in rows(f"{O}/a08-{s}.txt",c)if not sk.search(l)}for s in X)
  if c=="extension":g=lambda xs:{re.sub(r"version=[^;|]*","",l)for l in xs if l.split("|")[1].startswith(("vector","pg_trgm","unaccent","fuzzystrmatch","uuid-ossp","pgcrypto","pg_stat_statements"))};a,b=g(a),g(b)
  a8[c]={"source":len(a),"staging":len(b),"only_source":sorted(a-b)[:15],"only_staging":sorted(b-a)[:15]}
 V["A08"]=all(not v["only_source"]and not v["only_staging"]for v in a8.values());R["a08"]=a8;log(f"A08 {'PASS'if V['A08']else'FAIL'} "+" ".join(f"{k}={v['source']}/{v['staging']}"for k,v in a8.items()))
 if DATA=="full":
  for s,sd in(("source","source"),("staging","target")):q(X[s],["-v","mode=production","-v","side="+sd,"-v","checksum_scope=critical","-f",A+"/A09-migration-acceptance-suite.sql"],f"{O}/a09-{s}.txt")
  fp=lambda s:{l for l in rows(f"{O}/a09-{s}.txt")if l.startswith("fp|")};d=sorted(fp("source")^fp("staging"));fl=[l for l in rows(O+"/a09-staging.txt")if l.startswith("chk|")and l.endswith("|FAIL")]
  if not fp("source")or not fp("staging"):done(2,"A09 production mode produced no fp| lines",70)
  V["A09"]=not d and not fl;R["a09"]={"mode":"production","fp_differences":len(d),"fp_sample":d[:30],"staging_fail":fl[:30]}
 else:
  rc,_=q(X["staging"],["-v","mode=staging","-f",A+"/A09-migration-acceptance-suite.sql"],O+"/a09-staging.txt");s7=open(O+"/a07-source.txt").read();fl=[]
  for l in rows(O+"/a09-staging.txt"):
   f=l.split("|")
   if not l.endswith("|FAIL")or"summary"in l:continue
   if len(f)>3 and f[2]=="constraint_valid"and re.search(re.escape(f[3].split(".")[-1])+r".*validated=false",s7):continue
   if len(f)>3 and f[2]=="critical_present"and not re.search(r"^table\|"+re.escape(f[3].split(".")[-1])+r"\|",s7,re.M):continue
   fl.append(l)
  gt=next((l for l in rows(O+"/a09-staging.txt")if"|GATE|"in l),"none");R["a09"]={"mode":"staging","psql_rc":rc,"gate":gt,"fail":fl[:30]}
  if rc and gt=="none":R["steps"]["a09"]="ERROR";done(2,"A09 did not complete: "+open(O+"/a09-staging.txt.err").read()[-300:],70)
  V["A09"]=not fl
 log(f"A09 {'PASS'if V['A09']else'FAIL'} "+json.dumps(R["a09"])[:500]);R["verdict"]=V;done(0 if all(V.values())else 1,"" if all(V.values())else"unexplained: "+",".join(k for k,v in V.items()if not v),10+(not V["A07"])+2*(not V["A08"])+4*(not V["A09"]))
try:main()
except SystemExit:raise
except Exception as x:done(2,f"runner error {type(x).__name__}: {x}",90)
