import { assertPublicUrl } from './ketch.ts';

// Downloads images for the view_image tool, so a vision model can look at pictures people link on IRC.

export type FetchedImage = { url: string; data: string; mimeType: string; bytes: number };

const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 1024 * 1024; // enough of an HTML page to find its og:image
const USER_AGENT = 'Mozilla/5.0 (compatible; tsbot image fetcher)';

// Formats llama.cpp's image loader (stb_image) can decode, recognised by their first bytes
// rather than the Content-Type header, which servers often get wrong
const SIGNATURES: [string, (b: Uint8Array) => boolean][] = [
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  ['image/bmp', b => b[0] === 0x42 && b[1] === 0x4d],
];

const isWebp = (b: Uint8Array) =>
  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

// Follow redirects by hand, so every hop gets the private-address check
async function fetchPublic(rawUrl: string, signal?: AbortSignal): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await assertPublicUrl(url);
    const response = await fetch(checked, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,text/html;q=0.8,*/*;q=0.5' },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, checked).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${checked.href} returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw new Error(`Too many redirects fetching ${rawUrl}.`);
}

// Read at most maxBytes of the body, without buffering anything bigger first
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`The file is too big (${Math.round(declared / 1024)} KB, the limit is ${Math.round(maxBytes / 1024)} KB).`);
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      await response.body.cancel();
      throw new Error(`The file is too big (over ${Math.round(maxBytes / 1024)} KB).`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The preview image a page advertises, e.g. the picture on an imgur or news page
function findPageImage(html: string, pageUrl: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase();
    if (key !== 'og:image' && key !== 'og:image:url' && key !== 'og:image:secure_url' && key !== 'twitter:image') continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!content) continue;
    try {
      return new URL(content.replace(/&amp;/g, '&'), pageUrl).href;
    } catch {
      // Not a usable URL, try the next tag
    }
  }
  return undefined;
}

export async function fetchImage(rawUrl: string, maxBytes: number, signal?: AbortSignal): Promise<FetchedImage> {
  let response = await fetchPublic(rawUrl, signal);
  let finalUrl = response.url || rawUrl;

  // A web page rather than an image: use the image it shares as its preview
  if (/^text\/html|^application\/xhtml/i.test(response.headers.get('content-type') ?? '')) {
    const html = new TextDecoder().decode(await readLimited(response, MAX_PAGE_BYTES).catch(() => new Uint8Array()));
    const imageUrl = findPageImage(html, finalUrl);
    if (!imageUrl) throw new Error(`${rawUrl} is a web page, not an image, and it has no preview image.`);
    response = await fetchPublic(imageUrl, signal);
    finalUrl = response.url || imageUrl;
  }

  const bytes = await readLimited(response, maxBytes);
  const mimeType = SIGNATURES.find(([, matches]) => matches(bytes))?.[0];
  if (!mimeType) {
    if (isWebp(bytes)) throw new Error('That image is WebP, which the model server cannot read. Ask for a JPEG or PNG link.');
    throw new Error(`${finalUrl} is not a JPEG, PNG, GIF or BMP image (got ${response.headers.get('content-type') ?? 'unknown type'}).`);
  }
  return { url: finalUrl, data: Buffer.from(bytes).toString('base64'), mimeType, bytes: bytes.length };
}
