const cacheGet = (k) => {
  const v = segmentCache.get(k);
  if (!v) return null;
  if (now() - v.ts > SEG_CACHE_TTL) { segmentCache.delete(k); return null; }
  return v.data;
};

const cached = cacheGet(segUrlStr);
if (cached && !terminate && !stopped) {
  res.write(cached);
  didStream = true;
  seen.add(s);
  i += 1;
  continue;
}
