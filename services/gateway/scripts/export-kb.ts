/**
 * KB Export Script
 * Converts vitana-docs/ markdown files to structured JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import matter from 'gray-matter';

// IMPORTANT: always resolve paths relative to repo root
const ROOT_DIR = path.resolve(__dirname, '../../..'); // from services/gateway/scripts → repo root
const VITANA_DOCS_DIR = path.join(ROOT_DIR, 'vitana-docs');
const KB_OUTPUT_DIR = path.join(ROOT_DIR, 'kb');

interface DocFamily {
  id: string;
  name: string;
  description?: string;
  order: number;
}

interface IndexYAML {
  families: DocFamily[];
}

interface DocSection {
  section_id: string;
  id: string;
  level: number;
  title: string;
  content: string;
  content_markdown: string;
  word_count: number;
}

interface DocSnapshot {
  doc_id: string;
  title: string;
  family_id: string;
  family_name: string;
  status: string;
  version: string;
  tags: string[];
  description?: string;
  authors?: string[];
  last_updated: string;
  word_count: number;
  sections: DocSection[];
  metadata: Record<string, any>;
}

interface DocMetadata {
  doc_id: string;
  title: string;
  family_id: string;
  family_name: string;
  status: string;
  version: string;
  tags: string[];
  description?: string;
  last_updated: string;
  word_count: number;
  section_count: number;
}

interface KBIndex {
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

class KBExporter {
  private families: Map<string, DocFamily> = new Map();

  async export(): Promise<void> {
    console.log('🚀 Starting KB export...');
    console.log(`   Docs directory: ${VITANA_DOCS_DIR}`);
    console.log(`   Output directory: ${KB_OUTPUT_DIR}`);

    // Ensure output directory exists
    if (!fs.existsSync(KB_OUTPUT_DIR)) {
      fs.mkdirSync(KB_OUTPUT_DIR, { recursive: true });
    }

    // Load families from docs_index.yaml
    this.loadFamilies();

    // Find all markdown files
    const markdownFiles = this.findMarkdownFiles(VITANA_DOCS_DIR);
    console.log(`   Found ${markdownFiles.length} markdown files`);

    // Process each file
    const documents: DocSnapshot[] = [];
    for (const filePath of markdownFiles) {
      try {
        const doc = this.processMarkdownFile(filePath);
        if (doc) {
          documents.push(doc);
          // Write individual doc JSON
          const docPath = path.join(KB_OUTPUT_DIR, `${doc.doc_id}.json`);
          fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));
        }
      } catch (error) {
        console.error(`   ❌ Error processing ${filePath}:`, error);
      }
    }

    // Generate index
    const index = this.generateIndex(documents);
    const indexPath = path.join(KB_OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    console.log(`✅ Export complete!`);
    console.log(`   Total documents: ${documents.length}`);
    console.log(`   Total sections: ${documents.reduce((sum, d) => sum + d.sections.length, 0)}`);
    console.log(`   Total words: ${documents.reduce((sum, d) => sum + d.word_count, 0)}`);
  }

  private loadFamilies(): void {
    const indexFile = path.join(VITANA_DOCS_DIR, 'docs_index.yaml');
    
    if (!fs.existsSync(indexFile)) {
      throw new Error(`docs_index.yaml not found at ${indexFile}`);
    }

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    const indexData = yaml.load(indexContent) as IndexYAML;

    if (indexData.families) {
      for (const family of indexData.families) {
        this.families.set(family.id, family);
      }
      console.log(`   Loaded ${this.families.size} document families`);
    }
  }

  private findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(...this.findMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private processMarkdownFile(filePath: string): DocSnapshot | null {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content: markdown } = matter(content);

    const relativePath = path.relative(VITANA_DOCS_DIR, filePath);
    const docId = relativePath
      .replace(/\.md$/, '')
      .replace(/\\/g, '/')
      .replace(/\//g, '-')
      .toLowerCase();

    const familyId = frontmatter.family || this.inferFamily(relativePath);
    const family = this.families.get(familyId) || { id: 'default', name: 'Documentation', order: 0 };

    const { sections, wordCount } = this.parseSections(markdown);

    return {
      doc_id: docId,
      title: frontmatter.title || this.inferTitle(filePath),
      family_id: familyId,
      family_name: family.name,
      status: frontmatter.status || 'canonical',
      version: frontmatter.version || '1.0.0',
      tags: frontmatter.tags || [],
      description: frontmatter.description,
      authors: frontmatter.authors,
      last_updated: frontmatter.last_updated || new Date().toISOString(),
      word_count: wordCount,
      sections,
      metadata: frontmatter
    };
  }

  private parseSections(markdown: string): { sections: DocSection[]; wordCount: number } {
    const lines = markdown.split('\n');
    const sections: DocSection[] = [];
    let currentSection: Partial<DocSection> | null = null;
    let currentContent: string[] = [];
    let totalWords = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        if (currentSection) {
          const content = currentContent.join('\n').trim();
          currentSection.content = content;
          currentSection.content_markdown = content;
          currentSection.word_count = this.countWords(content);
          totalWords += currentSection.word_count!;
          sections.push(currentSection as DocSection);
        }

        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        const id = this.generateSectionId(title);

        currentSection = {
          section_id: id,
          id,
          level,
          title,
          content: '',
          content_markdown: '',
          word_count: 0
        };
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      const content = currentContent.join('\n').trim();
      currentSection.content = content;
      currentSection.content_markdown = content;
      currentSection.word_count = this.countWords(content);
      totalWords += currentSection.word_count!;
      sections.push(currentSection as DocSection);
    }

    return { sections, wordCount: totalWords };
  }

  private generateSectionId(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  private inferTitle(filePath: string): string {
    const basename = path.basename(filePath, '.md');
    return basename.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  private inferFamily(relativePath: string): string {
    const parts = relativePath.split(path.sep);
    if (parts.length > 1) {
      const firstDir = parts[0].replace(/^\d+-/, '').toLowerCase();
      if (this.families.has(firstDir)) return firstDir;
    }
    return 'default';
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }

  private generateIndex(documents: DocSnapshot[]): KBIndex {
    const docMetadata: DocMetadata[] = documents.map(doc => ({
      doc_id: doc.doc_id,
      title: doc.title,
      family_id: doc.family_id,
      family_name: doc.family_name,
      status: doc.status,
      version: doc.version,
      tags: doc.tags,
      description: doc.description,
      last_updated: doc.last_updated,
      word_count: doc.word_count,
      section_count: doc.sections.length
    }));

    const families: { [id: string]: { name: string; doc_count: number } } = {};
    for (const doc of documents) {
      if (!families[doc.family_id]) {
        families[doc.family_id] = { name: doc.family_name, doc_count: 0 };
      }
      families[doc.family_id].doc_count++;
    }

    return {
      total_docs: documents.length,
      docs: docMetadata,
      families,
      generated_at: new Date().toISOString()
    };
  }
}

const exporter = new KBExporter();
exporter.export().catch(error => {
  console.error('❌ Export failed:', error.message);
  process.exit(1);
});
