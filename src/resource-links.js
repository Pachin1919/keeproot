export function projectResourceHref(base, resourcePath = null, resourceId = null) {
  const query = new URLSearchParams();
  if (resourcePath) query.set('path', resourcePath);
  if (resourceId) query.set('resource_id', resourceId);
  return `${base}/resources${query.size ? `?${query.toString()}` : ''}`;
}
