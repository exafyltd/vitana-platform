/**
 * Sentry MCP - Error Tracking Integration
 * VTID-01178: Production error analysis and debugging
 *
 * Skills:
 *   - sentry.list_issues     - List recent issues/errors
 *   - sentry.get_issue       - Get issue details
 *   - sentry.get_stacktrace  - Get full stacktrace
 *   - sentry.search_similar  - Find similar issues
 *   - sentry.list_events     - List events for an issue
 */

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  project: {
    id: string;
    name: string;
    slug: string;
  };
  metadata: {
    type?: string;
    value?: string;
    filename?: string;
    function?: string;
  };
}

interface ListIssuesParams {
  project?: string;
  query?: string;
  status?: 'resolved' | 'unresolved' | 'ignored';
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  limit?: number;
}

interface GetIssueParams {
  issue_id: string;
}

interface SearchSimilarParams {
  issue_id?: string;
  error_message?: string;
  limit?: number;
}

interface ListEventsParams {
  issue_id: string;
  limit?: number;
}

function getSentryConfig(): { baseUrl: string; authToken: string; org: string } {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG || 'vitana';
  const baseUrl = process.env.SENTRY_BASE_URL || 'https://sentry.io/api/0';

  if (!authToken) {
    throw new Error('SENTRY_AUTH_TOKEN not configured');
  }

  return { baseUrl, authToken, org };
}

async function sentryFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const { baseUrl, authToken } = getSentryConfig();

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sentry API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * List recent issues from Sentry
 */
async function listIssues(params: ListIssuesParams): Promise<{
  issues: SentryIssue[];
  total: number;
}> {
  const { org } = getSentryConfig();
  const limit = Math.min(params.limit || 25, 100);

  const queryParts: string[] = [];
  if (params.status) queryParts.push(`is:${params.status}`);
  if (params.level) queryParts.push(`level:${params.level}`);
  if (params.query) queryParts.push(params.query);

  const queryString = queryParts.length > 0 ? `&query=${encodeURIComponent(queryParts.join(' '))}` : '';
  const projectFilter = params.project ? `&project=${params.project}` : '';

  const issues = await sentryFetch(
    `/organizations/${org}/issues/?limit=${limit}${projectFilter}${queryString}`
  );

  return {
    issues: issues.map((issue: any) => ({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      count: issue.count,
      userCount: issue.userCount,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      project: issue.project,
      metadata: issue.metadata || {},
    })),
    total: issues.length,
  };
}

/**
 * Get detailed issue information
 */
async function getIssue(params: GetIssueParams): Promise<{
  issue: SentryIssue;
  tags: Array<{ key: string; value: string; count: number }>;
  assignee: { name: string; email: string } | null;
}> {
  const issue = await sentryFetch(`/issues/${params.issue_id}/`);

  return {
    issue: {
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      count: issue.count,
      userCount: issue.userCount,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      project: issue.project,
      metadata: issue.metadata || {},
    },
    tags: (issue.tags || []).map((tag: any) => ({
      key: tag.key,
      value: tag.value,
      count: tag.count,
    })),
    assignee: issue.assignedTo
      ? { name: issue.assignedTo.name, email: issue.assignedTo.email }
      : null,
  };
}

/**
 * Get stacktrace for an issue
 */
async function getStacktrace(params: GetIssueParams): Promise<{
  exception: {
    type: string;
    value: string;
    stacktrace: Array<{
      filename: string;
      function: string;
      lineno: number;
      colno?: number;
      context_line?: string;
      pre_context?: string[];
      post_context?: string[];
    }>;
  } | null;
  breadcrumbs: Array<{
    category: string;
    message: string;
    level: string;
    timestamp: string;
  }>;
}> {
  // Get latest event for the issue
  const events = await sentryFetch(`/issues/${params.issue_id}/events/latest/`);

  const exception = events.entries?.find((e: any) => e.type === 'exception');
  const breadcrumbs = events.entries?.find((e: any) => e.type === 'breadcrumbs');

  let parsedStacktrace = null;
  if (exception?.data?.values?.[0]) {
    const exc = exception.data.values[0];
    parsedStacktrace = {
      type: exc.type || 'Error',
      value: exc.value || '',
      stacktrace: (exc.stacktrace?.frames || []).reverse().map((frame: any) => ({
        filename: frame.filename || frame.absPath || 'unknown',
        function: frame.function || '<anonymous>',
        lineno: frame.lineNo || 0,
        colno: frame.colNo,
        context_line: frame.contextLine,
        pre_context: frame.preContext,
        post_context: frame.postContext,
      })),
    };
  }

  const parsedBreadcrumbs = (breadcrumbs?.data?.values || []).map((bc: any) => ({
    category: bc.category || 'default',
    message: bc.message || '',
    level: bc.level || 'info',
    timestamp: bc.timestamp || '',
  }));

  return {
    exception: parsedStacktrace,
    breadcrumbs: parsedBreadcrumbs,
  };
}

/**
 * Search for similar issues
 */
async function searchSimilar(params: SearchSimilarParams): Promise<{
  similar: Array<{
    issue: SentryIssue;
    similarity_score: number;
  }>;
}> {
  const { org } = getSentryConfig();
  const limit = Math.min(params.limit || 10, 50);

  let query = '';
  if (params.error_message) {
    query = params.error_message;
  } else if (params.issue_id) {
    // Get the original issue to extract error message
    const issue = await sentryFetch(`/issues/${params.issue_id}/`);
    query = issue.metadata?.value || issue.title;
  }

  if (!query) {
    throw new Error('Either issue_id or error_message required');
  }

  // Search by the error message
  const searchQuery = encodeURIComponent(query.substring(0, 100));
  const issues = await sentryFetch(
    `/organizations/${org}/issues/?limit=${limit}&query=${searchQuery}`
  );

  // Filter out the original issue and add similarity scores
  const similar = issues
    .filter((issue: any) => issue.id !== params.issue_id)
    .map((issue: any) => ({
      issue: {
        id: issue.id,
        shortId: issue.shortId,
        title: issue.title,
        culprit: issue.culprit,
        level: issue.level,
        status: issue.status,
        count: issue.count,
        userCount: issue.userCount,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        project: issue.project,
        metadata: issue.metadata || {},
      },
      // Simple similarity based on position in results
      similarity_score: 1 - (issues.indexOf(issue) / issues.length),
    }));

  return { similar };
}

/**
 * List events for an issue
 */
async function listEvents(params: ListEventsParams): Promise<{
  events: Array<{
    id: string;
    eventID: string;
    dateCreated: string;
    user: { id?: string; email?: string; ip_address?: string } | null;
    tags: Array<{ key: string; value: string }>;
    message: string;
  }>;
}> {
  const limit = Math.min(params.limit || 25, 100);

  const events = await sentryFetch(
    `/issues/${params.issue_id}/events/?limit=${limit}`
  );

  return {
    events: events.map((event: any) => ({
      id: event.id,
      eventID: event.eventID,
      dateCreated: event.dateCreated,
      user: event.user
        ? {
            id: event.user.id,
            email: event.user.email,
            ip_address: event.user.ip_address,
          }
        : null,
      tags: (event.tags || []).map((tag: any) => ({
        key: tag.key,
        value: tag.value,
      })),
      message: event.message || '',
    })),
  };
}

async function health() {
  try {
    const { org } = getSentryConfig();
    await sentryFetch(`/organizations/${org}/`);
    return { status: 'ok', message: 'Sentry MCP operational' };
  } catch (err: any) {
    return { status: 'error', error: String(err.message || err) };
  }
}

export const sentryMcpConnector = {
  name: 'sentry-mcp',

  async health() {
    return health();
  },

  async call(method: string, params: any) {
    switch (method) {
      case 'list_issues':
        return listIssues(params || {});
      case 'get_issue':
        return getIssue(params || {});
      case 'get_stacktrace':
        return getStacktrace(params || {});
      case 'search_similar':
        return searchSimilar(params || {});
      case 'list_events':
        return listEvents(params || {});
      default:
        throw new Error(`Unknown method for sentry-mcp: ${method}`);
    }
  },
};
