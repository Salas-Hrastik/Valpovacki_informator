/**
 * Minimalna podrška za robots.txt — poštujemo Disallow pravila za
 * User-agent: * (i za našeg agenta "ValpovoAIInformator").
 */
const USER_AGENT = 'ValpovoAIInformator';
const cache = new Map<string, string[]>(); // host -> popis Disallow prefiksa

export const CRAWLER_USER_AGENT = `${USER_AGENT}/1.0 (+https://valpovo.hr; sluzbeni gradski informator)`;

export async function isAllowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  let disallows = cache.get(u.hostname);

  if (!disallows) {
    disallows = [];
    try {
      const res = await fetch(`${u.protocol}//${u.host}/robots.txt`, {
        headers: { 'User-Agent': CRAWLER_USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        disallows = parseDisallows(await res.text());
      }
    } catch {
      // robots.txt nedostupan → ponašamo se konzervativno-dopušteno (uobičajena praksa)
    }
    cache.set(u.hostname, disallows);
  }

  return !disallows.some((prefix) => prefix !== '' && u.pathname.startsWith(prefix));
}

function parseDisallows(robotsTxt: string): string[] {
  const lines = robotsTxt.split('\n').map((l) => l.trim());
  const out: string[] = [];
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').split('#')[0].trim();
    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase().includes(USER_AGENT.toLowerCase());
    } else if (key === 'disallow' && applies) {
      out.push(value);
    }
  }
  return out;
}
