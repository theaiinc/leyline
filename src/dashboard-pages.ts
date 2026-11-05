export const DASHBOARD_PAGE_PATHS = [
  'spending',
  'providers',
  'routing',
  'keys',
  'benchmarks',
  'playground',
  'calculator',
  'activity',
  'offered',
] as const;

export type DashboardPagePath = (typeof DASHBOARD_PAGE_PATHS)[number];

export function isDashboardPagePath(pathname: string): boolean {
  const page = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return DASHBOARD_PAGE_PATHS.includes(page as DashboardPagePath);
}