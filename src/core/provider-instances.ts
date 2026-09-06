import { Provider } from './types';
import { azureOpenAIInstanceFamily } from '../providers/azure-openai';

/**
 * Declares one configuration field for a multi-instance provider family.
 * `role` tells the generic dashboard route how to store the value without
 * knowing anything provider-specific: `secret` goes through the api-key
 * store, `runtimeBaseUrl`/`runtimeModel` feed `RuntimeConfigurableProvider`,
 * and `extra` is arbitrary passthrough persisted in the instance manifest.
 */
export interface InstanceFieldSpec {
  key: string;
  label: string;
  role: 'secret' | 'runtimeBaseUrl' | 'runtimeModel' | 'extra';
  required?: boolean;
  placeholder?: string;
}

export interface InstanceFamilyDefinition {
  /** Matches `Provider.family` and the manifest account key. */
  family: string;
  /** The un-suffixed provider name used by the single, env-configured default instance. */
  baseName: string;
  /** Human-readable family name for the dashboard. */
  displayName: string;
  fields: InstanceFieldSpec[];
  /** Extracts naming-relevant hints from a raw config object, for instance-id generation. */
  namingHint: (config: Record<string, string>) => { endpoint: string; deployment: string };
  /** Builds a new provider instance from a raw config object plus a generated id/label. */
  create: (config: { id?: string; label?: string } & Record<string, string>) => Provider;
}

/**
 * Provider families that support more than one configured instance.
 * Adding a family here (plus implementing it on the provider class) is the
 * only step needed to expose it through the generic dashboard UI/routes.
 */
export const INSTANCE_FAMILIES: InstanceFamilyDefinition[] = [azureOpenAIInstanceFamily];
