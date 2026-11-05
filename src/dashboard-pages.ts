export const DASHBOARD_PAGE_PATHS = ['/overview', '/benchmarks', '/providers', '/routing', '/keys', '/offered', '/playground', '/activity', '/spending', '/calculator', '/billing', '/data', '/usage', '/get-started'] as const;

export function isDashboardPagePath(pathname: string): boolean {
  return DASHBOARD_PAGE_PATHS.includes(pathname as (typeof DASHBOARD_PAGE_PATHS)[number]);
}