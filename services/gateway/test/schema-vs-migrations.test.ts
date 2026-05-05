import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Schema vs Migrations Contract', () => {
  it('ensures all columns used in .select() exist in migrations', () => {
    const srcDir = path.resolve(__dirname, '../src');
    // In a monorepo setup, migrations are usually at the root supabase/migrations
    const possibleMigrationDirs = [
      path.resolve(__dirname, '../../../supabase/migrations'),
      path.resolve(__dirname, '../../supabase/migrations'),
      path.resolve(__dirname, '../../../../supabase/migrations')
    ];
    
    const migrationsDir = possibleMigrationDirs.find(d => fs.existsSync(d));
    
    let allMigrations = '';
    if (migrationsDir) {
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
      for (const f of files) {
        allMigrations += fs.readFileSync(path.join(migrationsDir, f), 'utf-8') + '\n';
      }
    } else {
      console.warn('Migrations directory not found in typical relative paths. Skipping SQL load.');
    }

    const checkDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, f);
        if (fs.statSync(fullPath).isDirectory()) {
          checkDir(fullPath);
        } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'supabase.ts') {
          const content = fs.readFileSync(fullPath, 'utf-8');
          
          // Match simple select statements like .select('col1, col2')
          const matches = [...content.matchAll(/\.select\(['"]([^'"]+)['"]\)/g)];
          for (const match of matches) {
            const cols = match[1].split(',').map(c => c.trim()).filter(c => c && c !== '*');
            for (let col of cols) {
              // Extract base column names from postgres functions (e.g. count(id))
              if (col.includes('(')) {
                const innerMatch = col.match(/\(([^)]+)\)/);
                if (innerMatch) col = innerMatch[1].split(',')[0].trim();
              }
              // Extract column names from aliased selections (e.g. status:task_status)
              if (col.includes(':')) {
                col = col.split(':')[1].trim();
              }
              
              // Only assert if we successfully located and loaded migration files
              if (allMigrations && col && !col.includes('*')) {
                expect(
                  allMigrations.includes(col), 
                  `Safety Gap: Column '${col}' used in ${f} but not found in any migration file.`
                ).toBe(true);
              }
            }
          }
        }
      }
    };
    
    checkDir(srcDir);
  });
});