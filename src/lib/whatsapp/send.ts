import 'server-only';

import { serverEnv, whatsappConfigured } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service';

import { buildOrderConfirmationPayload, toWhatsAppNumber } from './payload';

/**
 * WhatsApp order confirmation via the Meta Cloud API, with the same
 * single-delivery guarantee as the email sender (src/lib/email/send.ts): claim
 * a notification_logs row first, only the winner calls the provider, and a
 * failure demotes the row so a retry stays possible.
 *
 * Never allowed to fail an order — the caller wraps this, and every outcome is
 * a value, not a throw. Nothing here reports a send it did not achieve.
 */

const GRAPH_VERSION = 'v25.0';
const REQUEST_TIMEOUT_MS = 6000;

export type WhatsAppOutcome =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'duplicate' }
  | { status: 'skipped'; message: string }
  | { status: 'not_configured'; message: string }
  | { status: 'failed'; message: string };

type SendArgs = {
  orderId: string;
  orderNumber: string;
  phone: string;
  customerName: string;
  totalPaise: number;
};

/**
 * Describes the shape of a stored token without revealing it: enough to tell
 * a duplicated paste or a stray invisible character from a genuine rejection.
 */
function describeTokenShape(token: string): string {
  const odd = [...token].filter((c) => !/[A-Za-z0-9]/.test(c));
  const codes = [...new Set(odd.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`))];
  const head = token.slice(0, 12);
  return [
    `prefix ${token.slice(0, 4)}`,
    `${token.length} chars`,
    `start-repeats=${token.indexOf(head, 1) !== -1}`,
    `non-alphanumeric=${odd.length}${codes.length ? ` [${codes.join(',')}]` : ''}`,
  ].join(', ');
}

/**
 * Asks Meta why a token was rejected. Returns a short human-readable reason;
 * never includes the token itself.
 */
async function inspectToken(token: string): Promise<string> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      },
    );
    const json = (await response.json().catch(() => null)) as {
      data?: {
        is_valid?: boolean;
        type?: string;
        app_id?: string;
        expires_at?: number;
        scopes?: string[];
        error?: { message?: string };
      };
      error?: { message?: string };
    } | null;

    if (json?.error?.message) return json.error.message;
    const d = json?.data;
    if (!d) return `no detail (HTTP ${response.status})`;
    return [
      `valid=${d.is_valid}`,
      d.type ? `type=${d.type}` : null,
      d.app_id ? `app=${d.app_id}` : null,
      d.expires_at !== undefined
        ? `expires=${d.expires_at === 0 ? 'never' : new Date(d.expires_at * 1000).toISOString().slice(0, 10)}`
        : null,
      d.scopes ? `scopes=${d.scopes.join('|')}` : null,
      d.error?.message ? `reason=${d.error.message}` : null,
    ]
      .filter(Boolean)
      .join(', ');
  } catch {
    return 'could not reach Meta to inspect the token';
  }
}

export async function sendWhatsAppOrderConfirmation(args: SendArgs): Promise<WhatsAppOutcome> {
  if (!whatsappConfigured()) {
    return {
      status: 'not_configured',
      message: 'WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.',
    };
  }

  const to = toWhatsAppNumber(args.phone);
  if (!to) {
    return { status: 'skipped', message: 'The phone number is not a valid Indian mobile number.' };
  }

  const supabase = createServiceClient();

  // ---- Step 1: claim the send ------------------------------------------
  const { data: claim, error: claimError } = await supabase
    .from('notification_logs')
    .insert({
      order_id: args.orderId,
      notification_type: 'whatsapp_order_confirmation',
      recipient: to,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (claimError) {
    if (claimError.code === '23505') return { status: 'duplicate' };
    return {
      status: 'failed',
      message: `Could not record the notification: ${claimError.message}`,
    };
  }

  const logId = claim.id;

  const demote = async (message: string) => {
    await supabase
      .from('notification_logs')
      .update({ status: 'failed', error_message: message.slice(0, 1000), sent_at: null })
      .eq('id', logId);
  };

  // ---- Step 2: send ------------------------------------------------------
  const env = serverEnv();

  const body = buildOrderConfirmationPayload({
    to,
    templateName: env.WHATSAPP_TEMPLATE_NAME || 'order_confirmation',
    languageCode: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    customerName: args.customerName,
    orderNumber: args.orderNumber,
    totalPaise: args.totalPaise,
    includeTrackButton: env.WHATSAPP_TEMPLATE_TRACK_BUTTON === 'true',
  });

  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    const json = (await response.json().catch(() => null)) as {
      messages?: { id?: string }[];
      error?: {
        message?: string;
        code?: number;
        type?: string;
        error_subcode?: number;
        fbtrace_id?: string;
      };
    } | null;

    if (!response.ok || json?.error) {
      // Token length (never the token) and Meta's trace id make a rejected
      // credential distinguishable from one that never reached the server.
      const e = json?.error;
      const detail = e
        ? [
            e.code ? `code ${e.code}` : null,
            e.error_subcode ? `subcode ${e.error_subcode}` : null,
            e.type ?? null,
            `HTTP ${response.status}`,
            `token length ${env.WHATSAPP_ACCESS_TOKEN?.length ?? 0}`,
            e.fbtrace_id ? `trace ${e.fbtrace_id}` : null,
          ]
            .filter(Boolean)
            .join(', ')
        : null;
      let message = e?.message
        ? `${e.message} (${detail})`
        : `WhatsApp API returned HTTP ${response.status}.`;
      if (e?.code === 190 && env.WHATSAPP_ACCESS_TOKEN) {
        message += ` Token check: ${await inspectToken(env.WHATSAPP_ACCESS_TOKEN)}. Token shape: ${describeTokenShape(env.WHATSAPP_ACCESS_TOKEN)}.`;
      }
      await demote(message);
      return { status: 'failed', message };
    }

    const providerMessageId = json?.messages?.[0]?.id ?? null;

    await supabase
      .from('notification_logs')
      .update({ provider_message_id: providerMessageId })
      .eq('id', logId);

    return { status: 'sent', providerMessageId };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Unexpected error sending WhatsApp message.';
    await demote(message);
    return { status: 'failed', message };
  }
}
