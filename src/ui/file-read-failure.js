export function describeFileReadFailure(error) {
  const code = String(error?.code ?? '');
  const detail = String(error?.message ?? error ?? 'Atlas could not read this file.');
  const text = `${code} ${detail}`.toLowerCase();
  const result = (kind, title, action, retrySupported, openSupported = true) => ({
    kind,
    title,
    detail,
    action,
    retry_supported: retrySupported,
    open_supported: openSupported,
  });
  if (code === 'ATLAS_CONTENT_INPUT_MISSING' || code === 'ENOENT') {
    return result('missing', 'File not found', 'Choose the file again or remove its saved trace.', false, false);
  }
  if (['EACCES', 'EPERM'].includes(code) || /permission|access denied/u.test(text)) {
    return result('permission', 'Permission denied', 'Allow local access, then retry the local read.', true);
  }
  if (['EBUSY', 'ETXTBSY'].includes(code) || /being used|in use|locked/u.test(text)) {
    return result('busy', 'File is in use', 'Close the application holding the file, then retry.', true);
  }
  if (code === 'ATLAS_CAPABILITY_UNAVAILABLE' || /component.+unavailable|python component/u.test(text)) {
    return result('component_unavailable', 'Local reader unavailable', 'Check Atlas Components, then retry.', true);
  }
  if (code === 'ATLAS_CONTENT_CACHE_UNAVAILABLE' || /cache.+(invalid|corrupt|unavailable)/u.test(text)) {
    return result('cache_unavailable', 'Previous local result is damaged', 'Rebuild the local result from the unchanged source file.', true);
  }
  if (code === 'ATLAS_STATE_CONFLICT' || /changed while/u.test(text)) {
    return result('changed', 'File changed during reading', 'Review the current file, then update the local result.', true);
  }
  if (/worksheet.+(missing|not found|does not exist)|sheet.+(missing|not found|does not exist)/u.test(text)) {
    return result('sheet', 'Worksheet was not found', 'Choose an available worksheet before reading the file again.', false);
  }
  if (/encoding|codec|decode|utf-/u.test(text)) {
    return result('encoding', 'Text encoding could not be determined', 'Open the file and export a copy with a supported text encoding.', false);
  }
  if (/header|column names|table start/u.test(text)) {
    return result('header', 'Table header could not be determined', 'Open the file and export a table with one clear header row.', false);
  }
  if (/corrupt|damaged|invalid (zip|workbook|document)|badzip/u.test(text)) {
    return result('corrupt', 'File appears damaged', 'Open or export a healthy copy, then choose it again.', false);
  }
  if (/unsupported|not supported/u.test(text)) {
    return result('unsupported', 'File format is not supported', 'Open it in the default app or convert a copy to a supported format.', false);
  }
  if (/parser|parse|malformed/u.test(text)) {
    return result('parser', 'File content could not be parsed', 'Open the file and export a healthy copy in a supported format.', false);
  }
  return result('unknown', 'Atlas could not read this file', 'Retry once. If it fails again, review the technical details below.', true);
}
