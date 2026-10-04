import importlib.util
from pathlib import Path
import unittest

P = Path(__file__).parents[1] / 'engine.py'
spec = importlib.util.spec_from_file_location('engine', P)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
ANCHOR = 'https://www.linkedin.com/in/jane-example'

def response(content, grounding, request='identity'):
    return {'requestId': request, 'output': {'content': content, 'grounding': grounding}, 'costDollars': {'total': .012}}

def ground(field, url=ANCHOR):
    return {'field': field, 'confidence': 'high', 'citations': [{'url': url, 'title': 'Synthetic Jane'}]}

def pair():
    return (response({'full_name':'Jane Example','linkedin_url':ANCHOR,'title':'Engineer'}, [ground('full_name'),ground('linkedin_url'),ground('title')]), response({'identity_status':'matched','identity_reason':'Synthetic anchor','skills':['Python'],'job_function':'engineering'}, [ground('skills'), ground('job_function')], 'signals'))

class GroundingTests(unittest.TestCase):
    def test_correct_identity_wrong_person_signals_are_withheld(self):
        a,b=pair(); b['output']['grounding'][0]=ground('skills','https://linkedin.com/in/another-person')
        out=engine.merge('Jane Example',ANCHOR,'',a,b)
        self.assertEqual(out['identity_match']['status'],'matched')
        self.assertEqual(out['person']['skills'],[])
        self.assertEqual(out['person']['title'],'Engineer')
        self.assertEqual(out['field_quality']['skills']['reason'],'conflicting_person_profile')
        self.assertIn('another-person',str(out['field_evidence']))
        self.assertEqual(out['meta']['cost_dollars'],.024)

    def test_matching_and_conflicting_citation_still_withholds(self):
        a,b=pair(); b['output']['grounding'][0]['citations'].append({'url':'https://linkedin.com/in/other'})
        self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['skills'],[])

    def test_unsubstantiated_field_is_unknown(self):
        a,b=pair(); b['output']['grounding']=[]
        out=engine.merge('Jane Example',ANCHOR,'',a,b)
        self.assertEqual(out['person']['skills'],[])
        self.assertIsNone(out['person']['job_function'])

    def test_canonical_profile_forms_are_same_identity(self):
        a,b=pair(); b['output']['grounding'][0]=ground('skills','https://uk.linkedin.com/in/JANE-EXAMPLE/?trk=test')
        self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['skills'],['Python'])

    def test_lookalike_and_non_http_sources_do_not_support_fact(self):
        for url in ['https://linkedin.com.evil.test/in/jane-example','file:///secret','javascript:evil']:
            a,b=pair(); b['output']['grounding'][0]=ground('skills',url)
            self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['skills'],[])

    def test_location_grounding_applies_to_location_components(self):
        a,b=pair(); a['output']['content']['location']='London | England | UK | GB | 51 | -0.1'
        a['output']['grounding'].append(ground('location','https://linkedin.com/in/wrong'))
        out=engine.merge('Jane Example',ANCHOR,'',a,b)
        self.assertIsNone(out['person']['city']); self.assertIsNone(out['person']['latitude'])

    def test_identity_drift_clears_all_attributes(self):
        a,b=pair(); a['output']['content']['linkedin_url']='https://linkedin.com/in/wrong'
        out=engine.merge('Jane Example',ANCHOR,'',a,b)
        self.assertEqual(out['identity_match']['status'],'ambiguous')
        self.assertTrue(all(v is None or v==[] for v in out['person'].values()))


class StageBoundaryTests(unittest.TestCase):
    def test_signal_stage_cannot_override_identity_fields(self):
        a,b=pair(); b['output']['content']['title']='Wrong employer'; b['output']['grounding'].append(ground('title','https://linkedin.com/in/wrong'))
        self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['title'],'Engineer')

    def test_array_index_grounding_is_recognized(self):
        a,b=pair(); b['output']['grounding'][0]['field']='skills[0]'
        self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['skills'],['Python'])

    def test_ungrounded_narrative_is_not_promoted_as_reason(self):
        a,b=pair(); b['output']['content']['identity_reason']='Other person seeks private aircraft'
        self.assertNotIn('aircraft',engine.merge('Jane Example',ANCHOR,'',a,b)['identity_match']['reason'])

class ProfileLinkTests(unittest.TestCase):
    def test_other_profile_urls_cannot_point_to_another_person(self):
        a,b=pair(); b['output']['content']['other_profile_urls']=['https://linkedin.com/in/wrong']
        b['output']['grounding'].append(ground('other_profile_urls'))
        self.assertEqual(engine.merge('Jane Example',ANCHOR,'',a,b)['person']['other_profile_urls'],[])

if __name__=='__main__': unittest.main()
