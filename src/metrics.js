const counters = {
  requests_total: 0,
  requests_failed: 0,
  media_streams_active: 0,
  bytes_streamed: 0,
  upstream_errors: 0,
  range_requests: 0,
  metadata_cache_hits: 0,
  metadata_cache_misses: 0,
};

export const metrics = {
  inc(name, by = 1) {
    counters[name] = (counters[name] ?? 0) + by;
  },
  snapshot() {
    return { ...counters };
  },
  reset() {
    for (const key of Object.keys(counters)) counters[key] = 0;
  },
};
