import type { Config, Handler } from '@netlify/functions';
import { handler as apiHandler } from './api5';

export const config: Config = { path: ['/api/baas', '/api/baas/*'] };

export const handler: Handler = async (event, context) => {
  const rawPath = event.path || '';
  const normalizedPath = rawPath.replace(/^\/.netlify\/functions\/baas/, '').replace(/^\/api\/baas/, '') || '/';
  return apiHandler({ ...event, path: normalizedPath, rawUrl: event.rawUrl?.replace(/\/api\/baas(?=\/|$)/, '') }, context);
};
