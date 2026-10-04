import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import io
import json

ROOT=Path(__file__).parents[1]
sys.path.insert(0,str(ROOT))
import enrich
from test_engine import pair, ANCHOR

class ClientTests(unittest.TestCase):
    def test_missing_anchor_is_free_skip(self):
        with patch.object(enrich.engine,'request_exa') as call:
            out=enrich.enrich_one({'name':'Jane Example'},api_key='synthetic')
            self.assertEqual(out['identity_match']['status'],'not_found'); call.assert_not_called()

    def test_stage_two_failure_retains_paid_receipt_without_raw_error(self):
        a,b=pair()
        with patch.object(enrich.engine,'request_exa',side_effect=[a,RuntimeError('secret response body')]):
            out=enrich.enrich_one({'name':'Jane Example','linkedin_url':ANCHOR},api_key='synthetic')
            self.assertEqual(out['meta']['cost_dollars'],.012)
            self.assertEqual(out['meta']['exa_request_ids'],['identity'])
            self.assertNotIn('secret',json.dumps(out)); self.assertEqual(out['status'],'error')

    def test_cache_is_scoped_by_name_context_and_version(self):
        a,b=pair()
        with tempfile.TemporaryDirectory() as cache, patch.object(enrich.engine,'request_exa',side_effect=lambda *args: pair()[0] if args[1]['outputSchema']==enrich.engine.schema_identity() else pair()[1]) as call:
            item={'name':'Jane Example','linkedin_url':ANCHOR,'context':'Synthetic event'}
            first=enrich.enrich_one(item,api_key='synthetic',cache_dir=cache)
            second=enrich.enrich_one(item,api_key=None,cache_dir=cache)
            self.assertFalse(first['meta']['cache_hit']); self.assertTrue(second['meta']['cache_hit'])
            self.assertEqual(second['meta']['cost_dollars'],0)
            self.assertEqual(second['meta']['original_cost_dollars'],.024)
            self.assertEqual(call.call_count,2)
            enrich.enrich_one({**item,'context':'Other event'},api_key='synthetic',cache_dir=cache)
            self.assertEqual(call.call_count,4)

    def test_cache_write_error_does_not_erase_paid_result(self):
        with patch.object(enrich.engine,'request_exa',side_effect=pair()), patch.object(enrich,'write_cache',side_effect=PermissionError):
            out=enrich.enrich_one({'name':'Jane Example','linkedin_url':ANCHOR},api_key='synthetic',cache_dir='/synthetic')
            self.assertEqual(out['meta']['cost_dollars'],.024)
            self.assertEqual(out['person']['title'],'Engineer')
            self.assertEqual(out['meta']['cache_status'],'write_failed')

    def test_bad_input_does_not_call_provider(self):
        for item in [{'name':'Jane','linkedin_url':'https://linkedin.com.evil/in/jane'}, {'name':'Jane','linkedin_url':ANCHOR,'context':{}}, {'name':'Jane','linkedin_url':ANCHOR,'email':'secret@x.com'}]:
            with patch.object(enrich.engine,'request_exa') as call:
                self.assertEqual(enrich.enrich_one(item,api_key='synthetic')['status'],'error'); call.assert_not_called()

    def test_missing_key_is_structured_error(self):
        out=enrich.enrich_one({'name':'Jane Example','linkedin_url':ANCHOR},api_key=None)
        self.assertEqual(out['error']['code'],'key_not_configured')

    def test_retry_count_and_delay_are_bounded(self):
        import urllib.error
        err=urllib.error.HTTPError('https://api.exa.ai/search',429,'limit',{'Retry-After':'999999'},io.BytesIO(b'private error'))
        with patch.object(enrich.engine.urllib.request,'urlopen',side_effect=err) as call,patch.object(enrich.engine.time,'sleep') as sleep:
            with self.assertRaises(RuntimeError): enrich.engine.request_exa('synthetic',{},retries=99)
            self.assertEqual(call.call_count,3)
            self.assertTrue(all(0<=c.args[0]<=10 for c in sleep.call_args_list))


class CacheBoundaryTests(unittest.TestCase):
    def make_cache(self, cache):
        item={'name':'Jane Example','linkedin_url':ANCHOR,'context':''}
        with patch.object(enrich.engine,'request_exa',side_effect=pair()):
            enrich.enrich_one(item,api_key='synthetic',cache_dir=cache)
        path=next(Path(cache).glob('*.json')); return item,path,json.loads(path.read_text())

    def test_expired_future_and_old_version_cache_miss(self):
        for change in [{'created_at':0},{'created_at':1e20},{'version':0}]:
            with tempfile.TemporaryDirectory() as cache:
                item,path,entry=self.make_cache(cache)
                path.write_text(json.dumps({**entry,**change}))
                with patch.object(enrich.engine,'request_exa',side_effect=pair()) as call:
                    self.assertFalse(enrich.enrich_one(item,api_key='synthetic',cache_dir=cache)['meta']['cache_hit'])
                    self.assertEqual(call.call_count,2)

    def test_cached_wrong_person_citation_is_rescreened(self):
        with tempfile.TemporaryDirectory() as cache:
            item,path,entry=self.make_cache(cache)
            entry['result']['field_evidence'][-2]['citations']=[{'url':'https://linkedin.com/in/wrong'}]
            path.write_text(json.dumps(entry))
            out=enrich.enrich_one(item,api_key=None,cache_dir=cache)
            self.assertTrue(out['meta']['cache_hit']); self.assertEqual(out['person']['skills'],[])

    def test_cache_file_permissions_are_private(self):
        with tempfile.TemporaryDirectory() as cache:
            item,path,entry=self.make_cache(cache)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_receipts_disclose_missing_cost_and_nonfinite_cost(self):
        for bad_cost in [None,-1,float('nan'),float('inf'),'0.012']:
            out=enrich.receipt([{'requestId':'synthetic','costDollars':{'total':bad_cost}}])
            self.assertFalse(out['cost_complete']); self.assertEqual(out['cost_dollars'],0)

if __name__=='__main__': unittest.main()
