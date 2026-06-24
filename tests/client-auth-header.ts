import { config } from '../src/config';

export const LEYLINE_CLIENT_AUTH_HEADER = {
  Authorization: `Bearer ${config.clientApiKey}`,
};
