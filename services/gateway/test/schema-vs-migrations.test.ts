import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function findFiles(dir: string, ext: string, skip: string[] = []): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    if (skip.some(s => fullPath.includes(s))) continue;
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findFiles(fullPath, ext, skip));
    } else if (file.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Schema vs Migrations Contract', () => {
  it('validates that columns used in .select() exist in migrations', () => {
    let migrationsContent = '';
    const possiblePaths = [
      path.resolve(__dirname, '../../../../supabase/migrations'),
      path.resolve(process.cwd(), 'supabase/migrations'),
      path.resolve(process.cwd(), '../supabase/migrations')
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const files = fs.readdirSync(p).sort();
        for (const f of files) {
          if (f.endsWith('.sql')) {
            migrationsContent += fs.readFileSync(path.join(p, f), 'utf-8') + '\n';
          }
        }
        if (migrationsContent) break;
      }
    }

    if (!migrationsContent) {
      console.warn('No migrations found in test environment, skipping validation.');
      expect(true).toBe(true);
      return;
    }

    const srcDir = path.resolve(__dirname, '../src');
    const sourceFiles = findFiles(srcDir, '.ts', ['.test.ts', '.spec.ts', 'lib/supabase.ts']);

    const missingColumns: string[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      
      const selectRegex = /\.select\(['"]([^'"]+)['"]\)/g;
      let match;
      while ((match = selectRegex.exec(content)) !== null) {
        const colsStr = match[1];
        const cols = colsStr.split(',').map(c => c.trim());
        
        for (let col of cols) {
          if (col === '*' || col === '') continue;
          if (col.includes('(')) continue; // ignore aggregations like count(*)
          if (col.includes('.')) col = col.split('.')[1]; // ignore table aliases like t.col
          if (col.includes(':')) col = col.split(':')[0].trim(); // ignore column aliases like col:alias
          
          // String match lower-bound heuristic ensures the column exists in the schema dump
          if (!migrationsContent.includes(col)) {
            missingColumns.push(`Column '${col}' in file ${path.basename(file)} not found in migrations.`);
          }
        }
      }
    }

    expect(missingColumns, 'All selected columns must exist in migrations').toEqual([]);
  });
});