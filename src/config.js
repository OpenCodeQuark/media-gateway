import { config as loadDotenv } from 'dotenv';

loadDotenv();

function intEnv(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `Invalid environment variable ${name}: expected an integer >= ${min}`,
    );
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function strEnv(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const nodeEnv = strEnv('NODE_ENV', 'development');
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error('Invalid NODE_ENV');
}

export const config = {
  port: intEnv('PORT', 5012, { min: 1 }),
  host: strEnv('HOST', '0.0.0.0'),
  nodeEnv,
  trustProxy: boolEnv('TRUST_PROXY', false),
  logLevel: strEnv('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
  rateLimitWindowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1 }),
  rateLimitMax: intEnv('RATE_LIMIT_MAX', 120, { min: 1 }),
  maxConcurrentStreams: intEnv('MAX_CONCURRENT_STREAMS', 100, { min: 0 }),
  mediaCacheControl: strEnv('MEDIA_CACHE_CONTROL', 'public, max-age=3600'),
  metadataCacheTtlMs: intEnv('METADATA_CACHE_TTL_MS', 300_000, { min: 1 }),
  metadataCacheMaxEntries: intEnv('METADATA_CACHE_MAX_ENTRIES', 1000, { min: 1 }),
  upstreamConnectTimeoutMs: intEnv('UPSTREAM_CONNECT_TIMEOUT_MS', 10_000, { min: 1 }),
  upstreamMetadataTimeoutMs: intEnv('UPSTREAM_METADATA_TIMEOUT_MS', 10_000, { min: 1 }),
  upstreamIdleTimeoutMs: intEnv('UPSTREAM_IDLE_TIMEOUT_MS', 60_000, { min: 1 }),
  googleApiKey: strEnv('GOOGLE_API_KEY') || undefined,
  googleClientId: strEnv('GOOGLE_CLIENT_ID') || undefined,
  googleClientSecret: strEnv('GOOGLE_CLIENT_SECRET') || undefined,
  googleRefreshToken: strEnv('GOOGLE_REFRESH_TOKEN') || undefined,
  shutdownTimeoutMs: intEnv('SHUTDOWN_TIMEOUT_MS', 30_000, { min: 1 }),
};

export const isProduction = config.nodeEnv === 'production';
export const isTest = config.nodeEnv === 'test';
