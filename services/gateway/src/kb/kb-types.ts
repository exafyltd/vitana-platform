/**
 * KB System Type Definitions
 */

export type DocStatus = 'canonical' | 'draft' | 'deprecated' | 'archived';

export interface DocSection {
  section_id: string;
  id: string;
  level: number;
  title: string;
  content: string;
  content_markdown?: string;
  word_count: number;
  parent_id?: string;
  subsections?: string[];
}

export interface DocSnapshot {
  doc_id: string;
  title: string;
  family_id: string;
  family_name: string;
  status: DocStatus;
  version: string;
  tags: string[];
  description?: string;
  authors?: string[];
  last_updated: string;
  word_count: number;
  sections: DocSection[];
  metadata: Record<string, any>;
}

export interface DocMetadata {
  doc_id: string;
  title: string;
  family_id: string;
  family_name: string;
  status: DocStatus;
  version: string;
  tags: string[];
  description?: string;
  last_updated: string;
  word_count: number;
  section_count: number;
}

export interface KBIndex {
  total_docs: number;
  docs: DocMetadata[];
  families: {
    [family_id: string]: {
      name: string;
      doc_count: number;
    };
  };
  generated_at: string;
}

export interface KBBundleDocRequest {
  doc_id: string;
  section_ids?: string[];
  sections?: string[];
  max_words?: number;
}

export interface KBBundleDoc {
  doc_id: string;
  title: string;
  family_id: string;
  family_name: string;
  sections: DocSection[];
  word_count: number;
  was_truncated?: boolean;
}

export interface KBBundleResponse {
  docs: KBBundleDoc[];
  total_words: number;
  truncated: boolean;
  requested_docs?: number;
  included_docs?: number;
  generated_at?: string;
}
