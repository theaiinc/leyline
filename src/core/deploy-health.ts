export interface DeployHealth {
  status: 'ok';
  service: 'leyline';
  commit?: string;
}

export function deployHealth(commit?: string): DeployHealth {
  return { status: 'ok', service: 'leyline', ...(commit ? { commit } : {}) };
}
