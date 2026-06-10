function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

function trustsProxyHeaders(): boolean {
  return (process.env.TRUST_PROXY_HEADERS ?? 'true').toLowerCase() !== 'false';
}

export function getClientIp(req: Request, fallback = 'unknown'): string {
  if (!trustsProxyHeaders()) return fallback;

  return (
    firstHeaderValue(req.headers.get('x-forwarded-for')) ||
    firstHeaderValue(req.headers.get('x-real-ip')) ||
    fallback
  );
}
