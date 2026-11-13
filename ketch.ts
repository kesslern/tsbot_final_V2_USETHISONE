import { execFile } from 'child_process';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { promisify } from 'util';

// Web search and page scraping through the ketch CLI (https://github.com/1broseidon/ketch),
// using whatever backend ketch is configured with.

const execFileAsync = promisify(execFile);

async function runKetch(args: string[], signal?: AbortSignal): Promise<unknown> {
  // execFile runs ketch directly, without a shell, so queries can't inject commands.
  // The '--' that callers put before user input stops it being read as a flag.
  const { stdout } = await execFileAsync('ketch', ['--json', ...args], {
    timeout: 45_000,
    maxBuffer: 5 * 1024 * 1024,
    signal,
  });
  return JSON.parse(stdout);
}

type SearchResult = { title?: string; url?: string; description?: string };

export async function ketchSearch(query: string, limit: number, signal?: AbortSignal): Promise<string> {
  const results = await runKetch(['search', '--limit', String(limit), '--', query], signal) as SearchResult[] | null;
  if (!results?.length) return `No results for: ${query}`;
  return results
    .map((r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${r.description ?? ''}`)
    .join('\n');
}

// Addresses on this machine or the local network, which IRC users must not be able to reach through the bot
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv6');
}

function isPrivateAddress(address: string): boolean {
  // IPv4 addresses written in IPv6 form, e.g. ::ffff:192.168.1.1
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return privateRanges.check(mapped, 'ipv4');
  return privateRanges.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be fetched.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // IPv6 hosts come wrapped in brackets
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new Error('That address is on a private network and cannot be fetched.');
  }
  return url;
}

type ScrapeResult = { url?: string; title?: string; markdown?: string };

export async function ketchScrape(rawUrl: string, maxChars: number, signal?: AbortSignal): Promise<string> {
  const url = await assertPublicUrl(rawUrl);
  const result = await runKetch(['scrape', '--trim', '--max-chars', String(maxChars), '--', url.href], signal) as ScrapeResult | ScrapeResult[];
  const page = Array.isArray(result) ? result[0] : result;
  if (!page?.markdown) return `No readable content at ${url.href}`;
  return `${page.title ?? url.href}\n${page.url ?? url.href}\n\n${page.markdown}`;
}
