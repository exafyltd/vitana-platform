import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Schema vs Migrations Contract', () => {
  it('ensures columns used in .select() exist in the schema', () => {
    let currentDir = __dirname;
    let migrationsDir = '';
    
    // Find supabase/migrations securely
    while (currentDir !== path.parse(currentDir).root) {
      const checkPath = path.join(currentDir, 'supabase', 'migrations');
      if (fs.existsSync(checkPath)) {
        migrationsDir = checkPath;
        break;
      }
      currentDir = path.dirname(currentDir);
    }

    if (!migrationsDir) {
      console.warn('Could not find supabase/migrations directory, skipping test');
      return;
    }

    // Read all migrations to form the complete known schema text
    const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
    let allMigrationsContent = '';
    for (const f of migrationFiles) {
      allMigrationsContent += fs.readFileSync(path.join(migrationsDir, f), 'utf-8') + '\n';
    }

    const srcDir = path.join(__dirname, '../src');
    const tsFiles = getTsFiles(srcDir);

    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      
      // Matches from('table').select('col1, col2')
      const selectRegex = /from\(\s*['"]([^'"]+)['"]\s*\)[^;]*?\.select\(\s*['"]([^'"]+)['"]\s*\)/g;
      let match;
      while ((match = selectRegex.exec(content)) !== null) {
        const table = match[1];
        const selectArgs = match[2];

        // Extract identifiers (potential column names)
        const words = selectArgs.match(/\b[a-z_][a-z0-9_]*\b/gi) || [];
        for (const word of words) {
          // Ignore SQL keywords and common PostgREST syntax that aren't columns
          if (['inner', 'left', 'right', 'count', 'exact', 'estimated', 'head', 'eq', 'neq', 'gt', 'lt', 'in', 'is', 'null', 'true', 'false', 'and', 'or'].includes(word.toLowerCase())) {
            continue;
          }

          // Check if the identifier appears anywhere in the SQL migrations
          if (!allMigrationsContent.includes(word)) {
            throw new Error(`Contract Violation: Column or property '${word}' used in select() for table '${table}' in file ${file} does not appear in any Supabase migration.`);
          }
        }
      }
    }
  });
});

function getTsFiles(dir: string, fileList: string[] = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getTsFiles(fullPath, fileList);
    } else if (fullPath.endsWith('.ts') && !fullPath.includes('.test.ts')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}