import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain',
]);

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19));
}

function proxyBenchmarkIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function privateIp(address) {
  if (net.isIP(address) === 4) return privateIpv4(address);
  if (net.isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice(7));
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized) || normalized.startsWith('ff');
}

async function publicUrl(value, lookupHost) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('capture fetch requires one valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('capture fetch supports public HTTP/HTTPS URLs without embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) {
    throw new Error('capture fetch refuses local hostnames.');
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await lookupHost(host, { all: true, verbatim: true });
  const allowProxyBenchmark = parsed.protocol === 'https:' && net.isIP(host) === 0;
  const refused = addresses.some((entry) => (
    privateIp(entry.address)
    && !(allowProxyBenchmark && proxyBenchmarkIpv4(entry.address))
  ));
  if (!addresses.length || refused) {
    throw new Error('capture fetch refuses private, local, multicast, or unresolved network targets.');
  }
  return {
    url: parsed,
    resolver_mode: addresses.some((entry) => proxyBenchmarkIpv4(entry.address))
      ? 'https_proxy_fake_ip'
      : 'public_dns',
  };
}

function decodeEntities(value) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ndash', '–'], ['mdash', '—'], ['hellip', '…'],
  ]);
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, entity) => {
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(
        entity.startsWith('#x') ? entity.slice(2) : entity.slice(1),
        entity.startsWith('#x') ? 16 : 10,
      );
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return named.get(entity.toLowerCase()) ?? whole;
  });
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u0000/gu, '')
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function htmlDocument(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const title = normalizeText(decodeEntities(titleMatch?.[1]?.replace(/<[^>]+>/gu, ' ') ?? ''));
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ');
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|h[1-6]|li|tr|table|blockquote|pre)>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '- ');
  return {
    title,
    text: normalizeText(decodeEntities(withBreaks.replace(/<[^>]+>/gu, ' '))),
  };
}

function flattenedValue(table, index, memo = new Map()) {
  if (!Number.isInteger(index) || index < 0) return null;
  if (memo.has(index)) return memo.get(index);
  const value = table[index];
  if (Array.isArray(value)) {
    const hydrated = [];
    memo.set(index, hydrated);
    for (const reference of value) hydrated.push(flattenedValue(table, reference, memo));
    return hydrated;
  }
  if (value && typeof value === 'object') {
    const hydrated = {};
    memo.set(index, hydrated);
    for (const [keyReference, reference] of Object.entries(value)) {
      if (!/^_\d+$/u.test(keyReference)) continue;
      const key = flattenedValue(table, Number(keyReference.slice(1)), memo);
      if (typeof key === 'string') hydrated[key] = flattenedValue(table, reference, memo);
    }
    return hydrated;
  }
  return value;
}

function referencedProperty(table, property) {
  const keyIndex = table.indexOf(property);
  if (keyIndex < 0) return null;
  const encodedKey = `_${keyIndex}`;
  for (const value of table) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, encodedKey)) {
      return flattenedValue(table, value[encodedKey]);
    }
  }
  return null;
}

function reactRouterTables(html) {
  const tables = [];
  const pattern = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\);/gu;
  let match;
  while ((match = pattern.exec(html)) != null) {
    try {
      const decoded = JSON.parse(match[1]);
      const table = JSON.parse(decoded);
      if (Array.isArray(table)) tables.push(table);
    } catch {
      // Other streamed chunks are not flattened loader data.
    }
  }
  return tables;
}

function chatGptShareDocument(html, currentUrl) {
  if (currentUrl.hostname.toLowerCase() !== 'chatgpt.com'
      || !currentUrl.pathname.toLowerCase().startsWith('/share/')) return null;
  for (const table of reactRouterTables(html)) {
    const nodes = referencedProperty(table, 'linear_conversation');
    if (!Array.isArray(nodes)) continue;
    const messages = [];
    for (const node of nodes) {
      const message = node?.message;
      const role = String(message?.author?.role ?? '').toLowerCase();
      if (!['user', 'assistant'].includes(role)) continue;
      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts.filter((part) => typeof part === 'string' && part.trim())
        : [];
      const content = normalizeText(parts.join('\n\n'));
      if (!content) continue;
      messages.push({
        message_id: String(message.id ?? node.id ?? '').trim() || null,
        parent_message_id: String(node.parent ?? '').trim() || null,
        timestamp: message.create_time ?? null,
        role,
        content,
      });
    }
    if (!messages.length) continue;
    const shareId = currentUrl.pathname.split('/').filter(Boolean).at(-1);
    return {
      title: normalizeText(referencedProperty(table, 'og_title')) || 'ChatGPT shared conversation',
      conversation_id: String(referencedProperty(table, 'backing_conversation_id') ?? shareId ?? '').trim(),
      messages,
    };
  }
  return null;
}

async function boundedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`capture fetch response exceeds ${MAX_DOWNLOAD_BYTES} bytes.`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error(`capture fetch response exceeds ${MAX_DOWNLOAD_BYTES} bytes.`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`capture fetch response exceeds ${MAX_DOWNLOAD_BYTES} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPublicDocument(urlInput, {
  fetchImpl = globalThis.fetch,
  lookupHost = dns.lookup,
  timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime does not provide fetch.');
  let target = await publicUrl(urlInput, lookupHost);
  let current = target.url;
  const requestedUrl = current.toString();
  const resolverModes = new Set([target.resolver_mode]);
  let redirects = 0;
  let response;
  while (true) {
    response = await fetchImpl(current, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'user-agent': 'Atlas-Local-Capture/1.4',
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects >= MAX_REDIRECTS) throw new Error(`capture fetch exceeds ${MAX_REDIRECTS} redirects.`);
    const location = response.headers.get('location');
    if (!location) throw new Error('capture fetch received a redirect without a Location header.');
    await response.body?.cancel?.();
    target = await publicUrl(new URL(location, current).toString(), lookupHost);
    current = target.url;
    resolverModes.add(target.resolver_mode);
    redirects += 1;
  }
  if (!response.ok) throw new Error(`capture fetch returned HTTP ${response.status}.`);
  const rawContentType = response.headers.get('content-type') ?? '';
  const contentType = rawContentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`capture fetch does not localize content type ${contentType || '(missing)'}.`);
  }
  const bytes = await boundedBody(response);
  const charset = rawContentType.match(/charset=([^;\s]+)/iu)?.[1]?.replace(/["']/gu, '') ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  const decoded = decoder.decode(bytes);
  const chat = contentType === 'text/plain' ? null : chatGptShareDocument(decoded, current);
  const document = contentType === 'text/plain'
    ? { title: current.hostname, text: normalizeText(decoded) }
    : chat ?? htmlDocument(decoded);
  if (!chat && !document.text) throw new Error('capture fetch found no usable text in the static HTTP response.');
  return {
    capture: {
      schema: 'atlas-browser-capture.v1',
      capture_mode: chat ? 'chatgpt_share' : 'public_http',
      capture_scope: chat ? 'shared_linear_conversation' : 'static_http_response_text',
      completeness: chat ? 'shared_linear_conversation_complete' : 'static_response_complete_dynamic_content_not_proven',
      source_url: current.toString(),
      requested_url: requestedUrl,
      title: document.title || current.hostname,
      captured_at: new Date().toISOString(),
      ...(chat ? {
        conversation_id: chat.conversation_id,
        messages: chat.messages,
      } : { text: document.text }),
    },
    requested_url: requestedUrl,
    final_url: current.toString(),
    redirect_count: redirects,
    http_status: response.status,
    content_type: contentType,
    downloaded_bytes: bytes.length,
    resolver_mode: resolverModes.has('https_proxy_fake_ip') ? 'https_proxy_fake_ip' : 'public_dns',
    network_used: true,
    browser_used: false,
    external_application_used: false,
  };
}

export const PUBLIC_WEB_CAPTURE_MAX_BYTES = MAX_DOWNLOAD_BYTES;
