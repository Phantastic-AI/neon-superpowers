/** Wire contract for enrich.py --stdin; no provider SDK dependency. */
export interface EnrichmentInput {
  name: string;
  linkedin_url?: string | null;
  context?: string;
}

export type PersonField =
  | 'full_name' | 'title' | 'company' | 'company_domain' | 'industry' | 'bio'
  | 'linkedin_url' | 'personal_url' | 'github_url' | 'other_profile_urls'
  | 'seniority' | 'role_type' | 'job_function' | 'skills' | 'interests'
  | 'seeking' | 'offering' | 'city' | 'region' | 'country' | 'country_code'
  | 'latitude' | 'longitude';
export interface Citation { url: string; title?: string | null; }
export interface FieldEvidence {
  field: string;
  confidence?: string;
  stage: 'identity' | 'signals';
  citations?: Citation[];
}
export interface FieldQuality {
  status: 'anchored' | 'supported' | 'withheld';
  reason: string;
  citations?: string[];
}
export interface EnrichmentResult {
  status: 'ok' | 'skipped' | 'error';
  input?: EnrichmentInput;
  error?: { code: string };
  identity_match: {
    status: 'matched' | 'ambiguous' | 'not_found' | 'error';
    verification: 'linkedin_anchor' | 'none';
    confidence: number;
    reason: string;
  };
  person: Record<PersonField, string | string[] | number | null> | null;
  field_evidence: FieldEvidence[];
  field_quality: Partial<Record<PersonField, FieldQuality>>;
  sources: Citation[];
  unresolved_fields: PersonField[];
  meta: {
    exa_request_ids: string[];
    cost_dollars: number;
    cost_complete: boolean;
    cache_hit: boolean;
    original_cost_dollars?: number;
    original_request_ids?: string[];
    billing_unknown?: boolean;
    cache_status?: 'write_failed';
  };
}
