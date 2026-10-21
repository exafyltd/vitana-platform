/**
 * Analyze Service Skill - VTID-01164
 *
 * Prevents code duplication by analyzing existing endpoints and services.
 * Finds similar patterns and recommends where to implement new features.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AnalyzeServiceParams,
  AnalyzeServiceResult,
  ExistingService,
  SimilarPattern,
  SkillContext,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default file patterns for service search
 */
const DEFAULT_PATTERNS = [
  'services/gateway/src/routes/**/*.ts',
  'services/gateway/src/services/**/*.ts',
];

/**
 * Route patterns to detect
 */
const ROUTE_PATTERNS = [
  /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
];

/**
 * Service patterns to detect
 */
const SERVICE_PATTERNS = [
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+const\s+(\w+)\s*=\s*async/g,
];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Recursively find files matching a pattern
 */
function findFiles(baseDir: string, pattern: string): string[] {
  const files: string[] = [];

  // Convert glob pattern to directory and regex
  const parts = pattern.split('**');
  const startDir = path.join(baseDir, parts[0]);
  const filePattern = parts[1] ? parts[1].replace(/^\//, '') : '';
  const extension = filePattern.replace(/\*/g, '').replace(/^\/?/, '');

  function walkDir(dir: string) {
    try {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          if (!extension || entry.name.endsWith(extension)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Skip inaccessible directories
    }
  }

  walkDir(startDir);
  return files;
}

/**
 * Read file content safely
 */
function readFileContent(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return null;
  }
}

/**
 * Extract routes from file content
 */
function extractRoutes(
  content: string,
  filePath: string
): Array<{ method: string; path: string; handler: string }> {
  const routes: Array<{ method: string; path: string; handler: string }> = [];

  for (const pattern of ROUTE_PATTERNS) {
    // Reset regex
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        handler: path.basename(filePath, '.ts'),
      });
    }
  }

  return routes;
}

/**
 * Determine service type from file path
 */
function getServiceType(filePath: string): ExistingService['type'] {
  if (filePath.includes('/routes/')) return 'route';
  if (filePath.includes('/services/')) return 'service';
  if (filePath.includes('/controllers/')) return 'controller';
  if (filePath.includes('/middleware/')) return 'middleware';
  return 'service';
}

/**
 * Calculate relevance score based on keyword matches
 */
function calculateRelevance(
  content: string,
  filePath: string,
  keywords: string[],
  serviceName?: string
): number {
  const normalizedContent = content.toLowerCase();
  const normalizedPath = filePath.toLowerCase();

  let score = 0;
  let matches = 0;

  // Check service name match
  if (serviceName) {
    const normalizedName = serviceName.toLowerCase().replace(/-/g, '');
    if (normalizedPath.includes(normalizedName)) {
      score += 0.5;
    }
  }

  // Check keyword matches
  for (const keyword of keywords) {
    const normalizedKeyword = keyword.toLowerCase();
    if (normalizedContent.includes(normalizedKeyword)) {
      matches++;
    }
    if (normalizedPath.includes(normalizedKeyword)) {
      matches += 0.5;
    }
  }

  if (keywords.length > 0) {
    score += (matches / keywords.length) * 0.5;
  }

  return Math.min(score, 1.0);
}

/**
 * Extract code patterns from file
 */
function extractPatterns(content: string, filePath: string): SimilarPattern[] {
  const patterns: SimilarPattern[] = [];

  // Check for common patterns
  if (content.includes('emitOasisEvent')) {
    patterns.push({
      pattern_name: 'OASIS Event Emission',
      file_path: filePath,
      description: 'Uses OASIS event emission for observability',
      code_example: 'await emitOasisEvent({ vtid, type: "...", ... })',
      applicable_to: 'Any service requiring audit trail',
    });
  }

  if (content.includes('z.object') || content.includes('zod')) {
    patterns.push({
      pattern_name: 'Zod Validation',
      file_path: filePath,
      description: 'Uses Zod for request body validation',
      code_example: 'const schema = z.object({ ... })',
      applicable_to: 'API endpoints with request bodies',
    });
  }

  if (content.includes('Router()')) {
    patterns.push({
      pattern_name: 'Express Router',
      file_path: filePath,
      description: 'Uses Express Router for route organization',
      code_example: 'const router = Router(); router.get("/path", handler)',
      applicable_to: 'New route modules',
    });
  }

  if (content.includes('supabaseUrl') || content.includes('SUPABASE_')) {
    patterns.push({
      pattern_name: 'Supabase Integration',
      file_path: filePath,
      description: 'Integrates with Supabase for database operations',
      code_example: 'await fetch(`${supabaseUrl}/rest/v1/...`, { headers: { apikey: ... } })',
      applicable_to: 'Database-backed features',
    });
  }

  return patterns;
}

/**
 * Analyze files and find services
 */
function analyzeFiles(
  files: string[],
  keywords: string[],
  serviceName?: string,
  featureDescription?: string
): { services: ExistingService[]; patterns: SimilarPattern[] } {
  const services: ExistingService[] = [];
  const allPatterns: SimilarPattern[] = [];
  const seenPatterns = new Set<string>();

  for (const file of files) {
    const content = readFileContent(file);
    if (!content) continue;

    const routes = extractRoutes(content, file);
    const relevance = calculateRelevance(content, file, keywords, serviceName);

    // Only include if somewhat relevant
    if (relevance > 0.1 || routes.length > 0) {
      services.push({
        name: path.basename(file, '.ts'),
        file_path: file,
        type: getServiceType(file),
        endpoints: routes,
        relevance_score: relevance,
      });
    }

    // Extract patterns from relevant files
    if (relevance > 0.2) {
      const patterns = extractPatterns(content, file);
      for (const pattern of patterns) {
        if (!seenPatterns.has(pattern.pattern_name)) {
          seenPatterns.add(pattern.pattern_name);
          allPatterns.push(pattern);
        }
      }
    }
  }

  // Sort services by relevance
  services.sort((a, b) => b.relevance_score - a.relevance_score);

  return { services: services.slice(0, 10), patterns: allPatterns };
}

/**
 * Generate implementation recommendation
 */
function generateRecommendation(
  services: ExistingService[],
  patterns: SimilarPattern[],
  keywords: string[],
  featureDescription?: string
): AnalyzeServiceResult['implementation_recommendation'] {
  const notes: string[] = [];

  // Determine best location
  let location = 'services/gateway/src/routes/';
  let patternToFollow = 'Express Router pattern';
  let existingServiceToExtend: string | undefined;

  if (services.length > 0) {
    const topService = services[0];

    if (topService.relevance_score > 0.5) {
      // High relevance - extend existing service
      existingServiceToExtend = topService.file_path;
      location = path.dirname(topService.file_path);
      patternToFollow = `Pattern from ${topService.name}`;
      notes.push(`Found highly relevant existing service: ${topService.name}`);
      notes.push(`Consider extending rather than creating new file`);
    } else if (topService.type === 'service') {
      location = 'services/gateway/src/services/';
      notes.push('Create new service file in services directory');
    }
  }

  // Add pattern recommendations
  if (patterns.length > 0) {
    notes.push(`Recommended patterns: ${patterns.map(p => p.pattern_name).join(', ')}`);
  }

  // Add keyword-based notes
  if (keywords.some(k => k.toLowerCase().includes('auth'))) {
    notes.push('Ensure authentication middleware is applied');
  }
  if (keywords.some(k => k.toLowerCase().includes('api') || k.toLowerCase().includes('endpoint'))) {
    notes.push('Use Zod for request validation');
    notes.push('Emit OASIS events for observability');
  }

  return {
    location,
    pattern_to_follow: patternToFollow,
    existing_service_to_extend: existingServiceToExtend,
    notes,
  };
}

/**
 * Detect potential duplicates
 */
function detectDuplicates(
  services: ExistingService[],
  featureDescription?: string
): Array<{ file_path: string; description: string; similarity_score: number }> {
  const duplicates: Array<{ file_path: string; description: string; similarity_score: number }> = [];

  // High relevance services might be duplicates
  for (const service of services) {
    if (service.relevance_score > 0.7) {
      duplicates.push({
        file_path: service.file_path,
        description: `${service.type} with ${service.endpoints.length} endpoints - high similarity`,
        similarity_score: service.relevance_score,
      });
    }
  }

  return duplicates;
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Main skill handler
 */
export async function analyzeService(
  params: AnalyzeServiceParams,
  context: SkillContext
): Promise<AnalyzeServiceResult> {
  const {
    vtid,
    service_name,
    keywords = [],
    file_patterns = DEFAULT_PATTERNS,
    feature_description,
    include_tests = false,
  } = params;

  // Build search keywords
  const searchKeywords = [...keywords];
  if (service_name) {
    searchKeywords.push(...service_name.split(/[-_\s]+/));
  }
  if (feature_description) {
    searchKeywords.push(...feature_description.split(/\s+/).filter(w => w.length > 3));
  }

  // Emit start event
  await context.emitEvent('start', 'info', 'Service analysis started', {
    service_name: service_name || 'any',
    keywords: searchKeywords.slice(0, 5),
    patterns_count: file_patterns.length,
  });

  try {
    // Find all matching files
    const baseDir = process.cwd();
    let allFiles: string[] = [];

    for (const pattern of file_patterns) {
      const files = findFiles(baseDir, pattern);
      allFiles.push(...files);
    }

    // Filter out test files unless requested
    if (!include_tests) {
      allFiles = allFiles.filter(f =>
        !f.includes('.test.') &&
        !f.includes('.spec.') &&
        !f.includes('/__tests__/')
      );
    }

    // Deduplicate
    allFiles = [...new Set(allFiles)];

    // Analyze files
    const { services, patterns } = analyzeFiles(
      allFiles,
      searchKeywords,
      service_name,
      feature_description
    );

    // Generate recommendation
    const recommendation = generateRecommendation(
      services,
      patterns,
      searchKeywords,
      feature_description
    );

    // Detect duplicates
    const duplicates = detectDuplicates(services, feature_description);

    // Determine duplicate risk
    let duplicateRisk: 'none' | 'low' | 'medium' | 'high' = 'none';
    if (duplicates.length > 0) {
      const maxSimilarity = Math.max(...duplicates.map(d => d.similarity_score));
      if (maxSimilarity > 0.9) duplicateRisk = 'high';
      else if (maxSimilarity > 0.7) duplicateRisk = 'medium';
      else duplicateRisk = 'low';
    }

    const result: AnalyzeServiceResult = {
      ok: true,
      existing_services: services,
      similar_patterns: patterns,
      implementation_recommendation: recommendation,
      potential_duplicates: duplicates,
      summary: {
        services_found: services.length,
        patterns_found: patterns.length,
        files_analyzed: allFiles.length,
        duplicate_risk: duplicateRisk,
      },
    };

    // Emit success event
    await context.emitEvent(
      'success',
      duplicateRisk === 'high' ? 'warning' : 'success',
      `Service analysis completed: ${services.length} services found`,
      {
        services_found: services.length,
        patterns_found: patterns.length,
        duplicate_risk: duplicateRisk,
        files_analyzed: allFiles.length,
      }
    );

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `Service analysis failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      existing_services: [],
      similar_patterns: [],
      implementation_recommendation: {
        location: 'services/gateway/src/',
        pattern_to_follow: 'Express Router',
        notes: ['Analysis failed - using default recommendation'],
      },
      potential_duplicates: [],
      summary: {
        services_found: 0,
        patterns_found: 0,
        files_analyzed: 0,
        duplicate_risk: 'none',
      },
    };
  }
}
