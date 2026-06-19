import { NextResponse } from 'next/server';
import crypto from 'crypto';

// ─── Configuration ─────────────────────────────────────────────────────────
// Discord bot URL must be set via environment variable.
// Format: http://bot:3005/github/webhook
const DISCORD_BOT_URL = process.env.DISCORD_BOT_URL || '';

// Maximum payload size for incoming webhooks (100 KB — GitHub webhooks are small)
const MAX_BODY_BYTES = 100_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Verify the x-hub-signature-256 header using timing-safe comparison.
 * Returns `true` if the signature is valid or if no secret is configured
 * (allows unauthenticated webhooks for development).
 */
function verifySignature(payload: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // No secret configured — skip verification (development mode)
  if (!secret) return true;

  // Secret configured but signature missing
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    // Signature is not the expected format (e.g. wrong encoding)
    return false;
  }
}

/**
 * Read the request body as text with a size limit to prevent OOM attacks.
 */
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  // Check Content-Length header first (fast rejection)
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return null;
  }

  // Read the body in chunks to enforce the limit
  const reader = request.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) return null; // exceeded limit
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('');
}

// ─── Route Handler ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // ── Step 1: Read and validate payload size ─────────────────────────
    const payloadText = await readBodyWithLimit(request, MAX_BODY_BYTES);
    if (payloadText === null) {
      return NextResponse.json(
        { error: 'Payload too large (max 100 KB)' },
        { status: 413 },
      );
    }

    // ── Step 2: Verify HMAC signature ──────────────────────────────────
    const signature = request.headers.get('x-hub-signature-256');
    if (!verifySignature(payloadText, signature)) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid signature' },
        { status: 401 },
      );
    }

    // ── Step 3: Parse payload (syntax check only) ──────────────────────
    try {
      JSON.parse(payloadText);
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON payload' },
        { status: 400 },
      );
    }

    // ── Step 4: Forward to Discord bot ─────────────────────────────────
    if (!DISCORD_BOT_URL) {
      // Bot URL not configured — acknowledge delivery but do not forward.
      // This is not an error: the platform can run without the Discord bot.
      return NextResponse.json({
        success: true,
        message: 'Webhook received (forwarding disabled — DISCORD_BOT_URL not set)',
      });
    }

    const response = await fetch(DISCORD_BOT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
      body: payloadText,
      signal: AbortSignal.timeout(10_000), // 10s timeout for the forward
    });

    if (!response.ok) {
      console.error(
        '[webhook] Failed to forward to Discord bot:',
        response.status,
        response.statusText,
      );
      return NextResponse.json(
        { error: 'Failed to forward to bot' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Webhook forwarded successfully',
    });
  } catch (error) {
    console.error('[webhook] Unhandled error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}