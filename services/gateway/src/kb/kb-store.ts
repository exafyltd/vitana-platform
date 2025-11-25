import * as fs from 'fs';
import * as path from 'path';
import {
  KBIndex,
  DocSnapshot,
  DocSection,
  KBBundleDocRequest,
  KBBundleResponse,
  KBBundleDoc
} from './kb-types';

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

class KBStore {
  private kbDir: string;
  private index: KBIndex | null = null;
  private docCache: Map<string, DocSnapshot> = new Map();

  constructor() {
    this.kbDir = path.resolve(__dirname, '../../kb');
  }

  getIndex(): KBIndex {
    if (this.index) return this.index;

    const indexPath = path.join(this.kbDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`KB index not found at ${indexPath}. Run 'npm run export:kb' first.`);
    }

    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    this.index = JSON.parse(indexContent) as KBIndex;
    return this.index;
  }

  getDoc(docId: string): DocSnapshot | null {
    if (this.docCache.has(docId)) {
      return this.docCache.get(docId)!;
    }

    const docPath = path.join(this.kbDir, `${docId}.json`);
    if (!fs.existsSync(docPath)) return null;

    const docContent = fs.readFileSync(docPath, 'utf-8');
    const snapshot = JSON.parse(docContent) as DocSnapshot;
    this.docCache.set(docId, snapshot);
    return snapshot;
  }

  getFilteredIndex(filters: {
    family_id?: string;
    status?: string;
    tag?: string;
  }): KBIndex {
    const index = this.getIndex();
    let filteredDocs = [...index.docs];

    if (filters.family_id) {
      filteredDocs = filteredDocs.filter(doc => doc.family_id === filters.family_id);
    }
    if (filters.status) {
      filteredDocs = filteredDocs.filter(doc => doc.status === filters.status);
    }
    if (filters.tag) {
      filteredDocs = filteredDocs.filter(doc => filters.tag ? doc.tags.includes(filters.tag) : true);
    }

    return { ...index, total_docs: filteredDocs.length, docs: filteredDocs };
  }

  getSection(docId: string, sectionId: string): { doc_id: string; section: DocSection } | null {
    const doc = this.getDoc(docId);
    if (!doc) return null;

    const section = doc.sections.find((s: DocSection) => s.section_id === sectionId);
    if (!section) return null;

    return { doc_id: doc.doc_id, section };
  }

  getBundle(docs: KBBundleDocRequest[], maxTotalWords?: number): KBBundleResponse {
    const resultDocs: KBBundleDoc[] = [];
    let totalWords = 0;
    let truncated = false;

    for (const req of docs) {
      if (truncated) break;

      const snapshot = this.getDoc(req.doc_id);
      if (!snapshot) {
        throw new Error(`KB document not found: ${req.doc_id}`);
      }

      const allSections = snapshot.sections || [];
      const sectionsToInclude =
        req.section_ids && req.section_ids.length > 0
          ? allSections.filter((s: DocSection) => req.section_ids!.includes(s.section_id))
          : allSections;

      if (sectionsToInclude.length === 0) continue;

      const docSections: DocSection[] = [];
      let docWordCount = 0;

      for (const section of sectionsToInclude) {
        const sectionWords = countWords(section.content_markdown || section.content || '');

        if (maxTotalWords !== undefined && totalWords + sectionWords > maxTotalWords) {
          truncated = true;
          break;
        }

        docSections.push(section);
        docWordCount += sectionWords;
        totalWords += sectionWords;
      }

      if (docSections.length > 0) {
        resultDocs.push({
          doc_id: snapshot.doc_id,
          title: snapshot.title,
          family_id: snapshot.family_id,
          family_name: snapshot.family_name,
          sections: docSections,
          word_count: docWordCount
        });
      }
    }

    return { docs: resultDocs, total_words: totalWords, truncated };
  }
}

export const kbStore = new KBStore();
