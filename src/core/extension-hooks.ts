import type { CompletionRequest, CompletionResponse, Provider } from './types';

  export type WorkspaceContext = {
    workspaceId: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  };

  export interface WorkspaceResolver {
    resolve(request: HookRequest): Promise<WorkspaceContext | null> | WorkspaceContext | null;
  }

  export type AdmissionDecision =
    | { allowed: true; workspace?: WorkspaceContext }
    | { allowed: false; status?: number; code?: string; message?: string };

  export interface AdmissionPolicy {
    admit(context: AdmissionContext): Promise<AdmissionDecision> | AdmissionDecision;
  }

  export interface UsageRecorder {
    record(event: UsageEvent): Promise<void> | void;
  }

  export interface KeyPolicy {
    resolve(context: KeyContext): Promise<KeyDecision> | KeyDecision;
  }

  export type KeyDecision =
    | { allowed: true; key?: string; metadata?: Record<string, unknown> }
    | { allowed: false; status?: number; code?: string; message?: string };

  export interface RouteMount {
    path: string;
    method?: RouteMethod | RouteMethod[];
    mount(router: RouteMountTarget): void | Promise<void>;
  }

  export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';

  export type RouteMountTarget = {
    get(path: string, ...handlers: unknown[]): unknown;
    post(path: string, ...handlers: unknown[]): unknown;
    put(path: string, ...handlers: unknown[]): unknown;
    patch(path: string, ...handlers: unknown[]): unknown;
    delete(path: string, ...handlers: unknown[]): unknown;
    options(path: string, ...handlers: unknown[]): unknown;
    head(path: string, ...handlers: unknown[]): unknown;
    use(path: string, ...handlers: unknown[]): unknown;
  };

  export type HookRequest = {
    requestId?: string;
    request: CompletionRequest;
    key?: string;
    provider?: string;
    model?: string;
  };

  export type AdmissionContext = HookRequest & {
    workspace: WorkspaceContext | null;
  };

  export type KeyContext = HookRequest & {
    workspace: WorkspaceContext | null;
  };

  export type UsageEvent = {
    requestId: string;
    workspace: WorkspaceContext | null;
    request: CompletionRequest;
    response?: CompletionResponse;
    provider?: string;
    model?: string;
    usage?: CompletionResponse['usage'];
    error?: unknown;
  };

  export const defaultWorkspaceResolver: WorkspaceResolver = {
    resolve: () => null,
  };

  export const defaultAdmissionPolicy: AdmissionPolicy = {
    admit: () => ({ allowed: true }),
  };

  export const defaultUsageRecorder: UsageRecorder = {
    record: () => undefined,
  };

  export const defaultKeyPolicy: KeyPolicy = {
    resolve: () => ({ allowed: true }),
  };

  export function assertRouteMountsDoNotConflict(mounts: readonly RouteMount[]): void {
    const seen = new Set<string>();
    for (const mount of mounts) {
      const methods = Array.isArray(mount.method) ? mount.method : [mount.method || 'ALL'];
      for (const method of methods) {
        const key = `${method}:${mount.path}`;
        if (seen.has(key)) {
          throw new Error(`Conflicting route mount: ${method} ${mount.path}`);
        }
        seen.add(key);
      }
    }
  }

  export type ExtensionHooks = {
    workspaceResolver?: WorkspaceResolver;
    admissionPolicy?: AdmissionPolicy;
    usageRecorder?: UsageRecorder;
    keyPolicy?: KeyPolicy;
    routeMounts?: RouteMount[];
  };

  export function withDefaultExtensionHooks(hooks: ExtensionHooks = {}) {
    return {
      workspaceResolver: hooks.workspaceResolver || defaultWorkspaceResolver,
      admissionPolicy: hooks.admissionPolicy || defaultAdmissionPolicy,
      usageRecorder: hooks.usageRecorder || defaultUsageRecorder,
      keyPolicy: hooks.keyPolicy || defaultKeyPolicy,
      routeMounts: hooks.routeMounts || [],
    };
  }