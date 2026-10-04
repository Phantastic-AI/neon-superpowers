#!/usr/bin/env python3
"""Enrich one person using a known LinkedIn profile as the identity anchor."""
import json, re, time, unicodedata, urllib.error, urllib.request
from email.utils import parsedate_to_datetime
from urllib.parse import unquote, urlsplit
import math

API_URL = "https://api.exa.ai/search"
IDENTITY_FIELDS = ["full_name","title","company","company_domain","industry","bio","linkedin_url","personal_url","github_url","location"]
SIGNAL_FIELDS = ["seniority","role_type","job_function","skills","interests","seeking","offering","other_profile_urls","identity_status","identity_reason"]
PERSON_FIELDS = ["full_name","title","company","company_domain","industry","bio","linkedin_url","personal_url","github_url","other_profile_urls","seniority","role_type","job_function","skills","interests","seeking","offering","city","region","country","country_code","latitude","longitude"]
ARRAY_FIELDS = {"skills","interests","seeking","offering","other_profile_urls"}
IGNORED_NAME_TOKENS = {"dr", "mr", "mrs", "ms", "miss", "prof", "sir"}

def normalize_linkedin(url):
    """Require an HTTPS LinkedIn person URL; reject lookalikes and page URLs."""
    if not isinstance(url, str): return None
    try:
        parsed = urlsplit(url.strip())
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None,443): return None
        if host != "linkedin.com" and not host.endswith(".linkedin.com"): return None
        path = unquote(parsed.path).rstrip("/").casefold()
        if not re.fullmatch(r"/in/[a-z0-9_-]+|/pub/[a-z0-9_-]+(?:/[a-z0-9_-]+){0,3}", path): return None
        return "https://www.linkedin.com" + path
    except (ValueError, TypeError): return None

def li_slug(url):
    normalized = normalize_linkedin(url)
    return normalized.removeprefix("https://www.linkedin.com") if normalized else None

def name_tokens(value):
    """Comparable name tokens; ignore titles and weak ASCII initials."""
    normalized=unicodedata.normalize("NFKC",str(value or "")).casefold()
    return {
        token for token in re.findall(r"[^\W\d_]+",normalized,re.UNICODE)
        if token not in IGNORED_NAME_TOKENS and (len(token)>1 or not token.isascii())
    }

def names_compatible(expected,returned):
    """Require at least one substantive name token to corroborate identity."""
    expected_tokens=name_tokens(expected); returned_tokens=name_tokens(returned)
    return bool(expected_tokens and returned_tokens and expected_tokens & returned_tokens)

def scalar(desc): return {"type":["string","null"],"description":desc}
def arr(desc): return {"type":"array","items":{"type":"string"},"description":desc}

def schema_identity():
    p={k:scalar(k.replace("_"," ")) for k in IDENTITY_FIELDS[:-1]}
    p["location"] = scalar("Public professional location formatted as City | Region | Country | ISO-2 country code | city-centroid latitude | city-centroid longitude; use null components when unknown")
    return {"type":"object","properties":p,"required":[]}

def schema_signals():
    p={"seniority":scalar("Normalized seniority"),"role_type":scalar("Founder, executive, employee, investor, advisor, student, or other"),"job_function":scalar("Normalized job function"),"skills":arr("Publicly evidenced professional skills"),"interests":arr("Publicly evidenced interests"),"seeking":arr("Only explicitly stated things sought"),"offering":arr("Explicit services or clearly supported professional offerings"),"other_profile_urls":arr("Other clearly matching public professional profile URLs"),"identity_status":{"type":"string","enum":["matched","ambiguous","not_found"]},"identity_reason":scalar("Brief evidence-based identity decision")}
    return {"type":"object","properties":p,"required":["identity_status"]}

def request_exa(key, payload, retries=3):
    """Bounded transport. Never return raw provider errors or key material."""
    req=urllib.request.Request(API_URL,json.dumps(payload).encode(),headers={"Content-Type":"application/json","x-api-key":key},method="POST")
    for attempt in range(max(1,min(3,retries))):
        try:
            with urllib.request.urlopen(req,timeout=30) as r:
                data=r.read(2*1024*1024+1)
                if len(data)>2*1024*1024: raise RuntimeError("provider_response_too_large")
                response=json.loads(data,parse_constant=lambda x: (_ for _ in ()).throw(ValueError("invalid JSON number")))
                if not isinstance(response,dict): raise RuntimeError("provider_invalid_response")
                return response
        except urllib.error.HTTPError as e:
            if e.code==429 and attempt+1<max(1,min(3,retries)):
                wait=e.headers.get("Retry-After","2")
                try: delay=float(wait)
                except ValueError:
                    try: delay=(parsedate_to_datetime(wait)-parsedate_to_datetime(e.headers.get("Date"))).total_seconds()
                    except (ValueError,TypeError,AttributeError): delay=2
                if not math.isfinite(delay): delay=2
                time.sleep(max(0,min(10,delay))); continue
            raise RuntimeError("provider_http_"+str(e.code)) from None
        except (urllib.error.URLError,TimeoutError,OSError): raise RuntimeError("provider_connection_failed") from None
        except (ValueError,UnicodeError): raise RuntimeError("provider_invalid_response") from None

def cost_meta(responses):
    """Provider-reported receipt for every Exa call completed in this attempt."""
    ids=[]; total=0.0
    for resp in responses:
        if resp.get("requestId"): ids.append(resp["requestId"])
        total += float(((resp.get("costDollars") or {}).get("total") or 0))
    return {"exa_request_ids": ids, "cost_dollars": round(total, 6)}

def stage_payload(name,linkedin_url,context,stage):
    ctx=f" Known context: {context}." if context else ""
    if stage=="identity":
        query=f'Identify the public professional profile of the person with LinkedIn profile {linkedin_url}. Name is "{name}".{ctx} Return only facts for the same person.'
        prompt="Use public professional sources. The LinkedIn URL is the identity anchor. If the result points to a different LinkedIn profile, leave fields null. Location coordinates may only be the public city centroid; never expose a street/home address."
        schema=schema_identity()
    else:
        query=f'For the person with LinkedIn profile {linkedin_url}, classify professional role and find publicly evidenced skills, interests, explicit seeking, and offerings.{ctx}'
        prompt="Do not combine different people. The LinkedIn URL is the identity anchor. Seeking must be explicitly stated. Return empty arrays instead of guesses."
        schema=schema_signals()
    return {"query":query,"type":"deep","category":"people","numResults":10,"moderation":True,"systemPrompt":prompt,"outputSchema":schema,"contents":{"highlights":True}}

def content(resp):
    c=(resp.get("output") or {}).get("content") or {}
    if isinstance(c,str):
        try: c=json.loads(c)
        except json.JSONDecodeError: c={}
    return dict(c) if isinstance(c,dict) else {}

def uniq(values):
    out=[]; seen=set()
    for v in values or []:
        if not isinstance(v,str) or not v.strip(): continue
        k=v.strip().casefold()
        if k not in seen: seen.add(k); out.append(v.strip())
    return out

def screen_fields(person, grounds, anchor_url):
    """T738: preserve evidence but withhold unsupported/cross-person fields."""
    quality={}
    location_fields={"city","region","country","country_code","latitude","longitude"}
    for field,value in list(person.items()):
        if value is None or value==[]: continue
        if field=="linkedin_url":
            person[field]=normalize_linkedin(anchor_url)
            quality[field]={"status":"anchored","reason":"supplied_profile"}; continue
        evidence_field="location" if field in location_fields else field
        stage="identity" if evidence_field in IDENTITY_FIELDS else "signals"
        citations=[]
        for g in grounds:
            root=re.split(r"[.\[]",str(g.get("field","")))[0]
            if root==evidence_field and g.get("stage")==stage:
                citations.extend(g.get("citations",[]) if isinstance(g.get("citations"),list) else [])
        reason=None
        urls=[c.get("url") for c in citations if isinstance(c,dict)]
        for url in urls:
            profile=normalize_linkedin(url)
            if profile and profile!=normalize_linkedin(anchor_url): reason="conflicting_person_profile"; break
        valid=[]
        for url in urls:
            if not isinstance(url,str): continue
            try:
                parsed=urlsplit(url); host=(parsed.hostname or "").lower()
                if parsed.scheme not in ("http","https") or not host or parsed.username or parsed.password: continue
                if "linkedin" in host and not normalize_linkedin(url): continue
                valid.append(url)
            except ValueError: continue
        if field == "other_profile_urls" and isinstance(value,list):
            if any(normalize_linkedin(url) and normalize_linkedin(url)!=normalize_linkedin(anchor_url) for url in value):
                reason="conflicting_person_profile"
        if not valid and reason is None: reason="no_supporting_citation"
        if field in ARRAY_FIELDS:
            typed=isinstance(value,list) and all(isinstance(v,str) for v in value)
        elif field in {"latitude","longitude"}:
            typed=isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
        else: typed=isinstance(value,str)
        if not typed: reason="invalid_field_type"
        if reason:
            person[field]=[] if field in ARRAY_FIELDS else None
            quality[field]={"status":"withheld","reason":reason}
        else:
            quality[field]={"status":"supported","reason":"public_citation","citations":valid}
    return quality

def merge(name,linkedin_url,context,a,b):
    ai,bs=content(a),content(b); loc=ai.pop("location",None)
    if isinstance(loc,str):
        parts=[x.strip() for x in loc.split("|")]
        keys=["city","region","country","country_code","latitude","longitude"]
        loc={k:(None if i>=len(parts) or parts[i].lower() in ("", "null", "unknown") else parts[i]) for i,k in enumerate(keys)}
        for k in ("latitude","longitude"):
            try: loc[k]=float(loc[k]) if loc.get(k) is not None else None
            except (TypeError,ValueError): loc[k]=None
    elif not isinstance(loc,dict): loc={}
    person={k:([] if k in ARRAY_FIELDS else None) for k in PERSON_FIELDS}
    for k,v in ai.items():
        if k in IDENTITY_FIELDS and k in person and v not in ("",[],{}): person[k]=v
    for k,v in bs.items():
        if k in SIGNAL_FIELDS and k in person and v not in ("",[],{}): person[k]=uniq(v) if k in ARRAY_FIELDS and isinstance(v,list) else v
    for k in ("city","region","country","country_code","latitude","longitude"):
        if k in loc and loc[k] not in ("",[],{}): person[k]=loc[k]
    status=bs.get("identity_status","not_found"); reason="Automated profile and name checks only; field evidence is screened separately."
    grounds=[]; sources=[]; seen=set(); costs=0.0; ids=[]
    for stage, resp in (("identity",a),("signals",b)):
        ids.append(resp.get("requestId")); costs+=float(((resp.get("costDollars") or {}).get("total") or 0))
        for g in ((resp.get("output") or {}).get("grounding") or []):
            if not isinstance(g,dict): continue
            g={**g,"stage":stage}
            grounds.append(g)
            for c in g.get("citations",[]):
                u=c.get("url")
                if u and u not in seen: seen.add(u); sources.append({"url":u,"title":c.get("title")})
    if status not in {"matched","ambiguous","not_found"}: status="not_found"
    confidence={"high":0.9,"medium":0.65,"low":0.35}.get(max((g.get("confidence","") for g in grounds),key=lambda x:{"":0,"low":1,"medium":2,"high":3}.get(x,0),default=""),0.0)

    # ── Deterministic identity verification ─────────────────────────────
    # Exa's self-reported identity_status is necessary but NOT sufficient:
    # for common names the search happily returns a same-name stranger as
    # "matched". A match only survives with hard, checkable evidence, and
    # the evidence class is recorded as identity_match.verification:
    # linkedin_anchor means exact profile + corroborating name; it does not
    # mean human verification. Field citations are checked separately below.
    anchor=li_slug(linkedin_url)
    returned=li_slug(person.get("linkedin_url"))
    verification="none"
    if not anchor:
        status="ambiguous"
        reason="The supplied LinkedIn URL was not a valid /in/ or /pub/ person profile."
    elif not returned:
        status="ambiguous"
        reason=f"Exa did not return the anchored {anchor} profile, so a typo or inaccessible profile cannot be ruled out. {reason}"
    elif returned!=anchor:
        status="ambiguous"
        reason=f"Search drifted to {returned}, which is not the anchor {anchor} — cross-profile merges are refused. {reason}"
    elif not names_compatible(name,person.get("full_name")):
        status="ambiguous"
        reason="The returned profile name did not corroborate the attendee name, so the result may describe a different person and will not be saved."
    else:
        verification="linkedin_anchor"
        # The self-supplied anchor IS the identity; never overwrite it with a
        # same-name profile returned by search.
        if anchor: person["linkedin_url"]=linkedin_url

    quality=screen_fields(person,grounds,linkedin_url) if status=="matched" else {}
    if status!="matched": person={k:([] if k in ARRAY_FIELDS else None) for k in PERSON_FIELDS}
    unresolved=[k for k,v in person.items() if v is None or v==[]]
    input_obj={"name":name,"mode":"linkedin","context":context or None}
    if linkedin_url: input_obj["linkedin_url"]=linkedin_url
    return {"input":input_obj,"identity_match":{"status":status,"confidence":confidence,"verification":verification,"reason":reason},"person":person,"field_evidence":grounds,"field_quality":quality,"sources":sources,"unresolved_fields":unresolved,"meta":{"exa_request_ids":[x for x in ids if x],"cost_dollars":round(costs,6)}}
