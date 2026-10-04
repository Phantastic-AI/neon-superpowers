#!/usr/bin/env python3
"""One anchored attendee: importable API or one JSON stdin/stdout exchange."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import engine

CACHE_VERSION = 1
CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
MAX_INPUT_BYTES = 8192

def receipt(responses):
    ids, total, complete = [], 0.0, True
    for response in responses:
        request_id = response.get('requestId')
        if isinstance(request_id,str) and request_id: ids.append(request_id)
        cost = (response.get('costDollars') or {}).get('total') if isinstance(response.get('costDollars'),dict) else None
        if not isinstance(cost,(int,float)) or isinstance(cost,bool) or not math.isfinite(cost) or cost < 0:
            complete = False
        else: total += cost
    return {'exa_request_ids':ids, 'cost_dollars':round(total,6), 'cost_complete':complete, 'cache_hit':False}

def failure(code, completed=()):
    return {'status':'error', 'error':{'code':code}, 'identity_match':{'status':'error','verification':'none','confidence':0,'reason':code}, 'person':None, 'field_evidence':[], 'field_quality':{}, 'sources':[], 'unresolved_fields':[], 'meta':receipt(completed)}

def validate(item):
    if not isinstance(item,dict) or set(item)-{'name','linkedin_url','context'}: raise ValueError('invalid_input')
    name=item.get('name'); url=item.get('linkedin_url'); context=item.get('context','')
    if not isinstance(name,str) or not name.strip() or len(name)>200: raise ValueError('invalid_name')
    if not isinstance(context,str) or len(context)>4000: raise ValueError('invalid_context')
    if url in (None,''): return {'name':name.strip(),'linkedin_url':None,'context':context}
    if not isinstance(url,str) or len(url)>2048: raise ValueError('invalid_linkedin_url')
    normalized=engine.normalize_linkedin(url)
    if not normalized: raise ValueError('invalid_linkedin_url')
    return {'name':name.strip(),'linkedin_url':normalized,'context':context}

def cache_key(item):
    return hashlib.sha256(json.dumps({'version':CACHE_VERSION,**item},sort_keys=True).encode()).hexdigest()

def read_cache(directory,item):
    if directory is None: return None
    try:
        path=Path(directory)/(cache_key(item)+'.json')
        if path.stat().st_size>2*1024*1024: return None
        entry=json.loads(path.read_text())
        age=time.time()-entry['created_at']
        if entry['version']!=CACHE_VERSION or not 0<=age<CACHE_TTL_SECONDS or entry['input']!=item: return None
        result=entry['result']
        if result['identity_match']['status']!='matched' or result['identity_match']['verification']!='linkedin_anchor': return None
        if engine.normalize_linkedin(result['person'].get('linkedin_url'))!=item['linkedin_url']: return None
        # Re-screen cached attributes: caches are evidence, not authority.
        result['field_quality'].update(engine.screen_fields(result['person'],result['field_evidence'],item['linkedin_url']))
        original=result['meta']
        result['meta']={'exa_request_ids':[], 'cost_dollars':0, 'cost_complete':True, 'cache_hit':True, 'original_cost_dollars':original.get('cost_dollars'), 'original_request_ids':original.get('exa_request_ids',[])}
        return result
    except (OSError,ValueError,KeyError,TypeError,AttributeError): return None

def write_cache(directory,item,result):
    if directory is None: return
    directory=Path(directory); directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    destination=directory/(cache_key(item)+'.json')
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',dir=directory,prefix='.enrich-',delete=False) as file:
            temporary=file.name
            os.chmod(temporary,0o600)
            json.dump({'version':CACHE_VERSION,'created_at':time.time(),'input':item,'result':result},file,allow_nan=False)
            file.flush(); os.fsync(file.fileno())
        os.replace(temporary,destination)
    finally:
        if temporary and os.path.exists(temporary): os.unlink(temporary)

def enrich_one(item, *, api_key=None, cache_dir=None):
    """No disk/provider mutation besides an explicitly selected local cache."""
    try: item=validate(item)
    except ValueError as error: return failure(str(error))
    if not item['linkedin_url']:
        return {'status':'skipped','input':item,'identity_match':{'status':'not_found','verification':'none','confidence':0,'reason':'No LinkedIn anchor; no paid request made.'},'person':None,'field_evidence':[],'field_quality':{},'sources':[],'unresolved_fields':engine.PERSON_FIELDS,'meta':receipt([])}
    cached=read_cache(cache_dir,item)
    if cached: return cached
    if not api_key: return failure('key_not_configured')
    completed=[]
    try:
        for stage in ('identity','signals'):
            response=engine.request_exa(api_key,engine.stage_payload(item['name'],item['linkedin_url'],item['context'],stage))
            completed.append(response)
        result=engine.merge(item['name'],item['linkedin_url'],item['context'],*completed)
        result.update({'status':'ok','input':item})
        result['meta']=receipt(completed)
    except (RuntimeError,OSError,ValueError,TypeError,AttributeError,KeyError):
        result=failure('provider_failed',completed)
        result['meta']['billing_unknown']=True
        return result
    if result['identity_match']['status']=='matched':
        try: write_cache(cache_dir,item,result)
        except OSError: result['meta']['cache_status']='write_failed'
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stdin',action='store_true',required=True)
    parser.add_argument('--cache-dir',default=None,help='Explicit private local cache directory; disabled by default')
    args=parser.parse_args()
    data=sys.stdin.buffer.read(MAX_INPUT_BYTES+1)
    try:
        if len(data)>MAX_INPUT_BYTES: raise ValueError('input_too_large')
        item=json.loads(data)
        result=enrich_one(item,api_key=os.environ.get('EXA_API_KEY'),cache_dir=args.cache_dir)
    except (ValueError,UnicodeError): result=failure('invalid_json')
    print(json.dumps(result,allow_nan=False,ensure_ascii=False))

if __name__=='__main__': main()
