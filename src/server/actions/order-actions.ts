'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { publicEnv } from '@/lib/env';
import { describeOutcome, sendOrderEmail } from '@/lib/email/send';
import { orderShippedEmail } from '@/lib/email/templates';
import { sendWhatsAppOrderConfirmation } from '@/lib/whatsapp/send';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { orderStatusSchema, shipmentSchema } from '@/lib/validation';
import { recordAudit, requireAdmin, type AdminUser } from '@/server/auth';
import { STATUS_SEQUENCE } from '@/components/admin/status-badge';
import type { OrderStatus } from '@/lib/database.types';

/**
 * Admin order management.
 *
 * Every action begins with requireAdmin() for the same reason product-actions
 * does: a Server Action is a reachable POST endpoint independent of whichever
 * page happens to render a form for it, so the layout's guard does not cover
 * it on its own.
 *
 * Status changes go through the plain RLS-bound client — a workflow label
 * with no money or stock behind it does not need transactional rigor.
 * Cancelling is the one status change that has to touch inventory (returning
 * stock create_order took), so it goes through cancel_order(), a Postgres
 * function reached via the service client — the same pattern placeOrderAction
 * uses for create_order, and for the same reason: multiple sequential client
 * calls could restock some items and not others if one failed partway.
 */

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

const updateStatusInput = z.object({
  orderId: z.string().uuid(),
  status: orderStatusSchema,
});

/**
 * The actual status-change logic for one order, shared by the single-order
 * form and the bulk action below. Does not revalidate any paths itself —
 * callers do that once, after they know which order numbers were actually
 * touched, so a bulk change over 30 orders does not revalidate 30 times.
 */
async function applyOrderStatusChange(
  admin: AdminUser,
  orderId: string,
  status: OrderStatus,
): Promise<
  | { ok: true; message: string; orderNumber: string }
  | { ok: false; error: string; orderNumber?: string }
> {
  const supabase = await createClient();

  const { data: order, error: readError } = await supabase
    .from('orders')
    .select('order_number, status')
    .eq('id', orderId)
    .maybeSingle();

  if (readError || !order) {
    return { ok: false, error: 'Order not found.' };
  }

  if (order.status === status) {
    return {
      ok: true,
      message: `Order is already ${status.replace(/_/g, ' ')}.`,
      orderNumber: order.order_number,
    };
  }

  // Cancelling is terminal: it is the one transition that gives stock back,
  // and reversing that safely would mean re-checking stock is still
  // available before un-cancelling. Simpler and safer to require a fresh
  // order for that case than to guess at it here.
  if (order.status === 'cancelled') {
    return {
      ok: false,
      error: 'This order is cancelled and its status cannot be changed further.',
      orderNumber: order.order_number,
    };
  }

  if (status === 'cancelled') {
    const service = createServiceClient();
    const { error } = await service.rpc('cancel_order', { p_order_id: orderId });

    if (error) {
      return {
        ok: false,
        error: `Could not cancel the order: ${error.message}`,
        orderNumber: order.order_number,
      };
    }

    await recordAudit(admin, {
      action: 'order.cancelled',
      entityType: 'order',
      entityId: orderId,
      metadata: { order_number: order.order_number, from: order.status },
    });

    return {
      ok: true,
      message:
        'Order cancelled. Stock for its items has been restored. If this order was already paid, refund it separately in the Razorpay dashboard — cancelling here does not do that automatically.',
      orderNumber: order.order_number,
    };
  }

  // Ordinary forward-workflow transition: no stock or money implication,
  // a plain update under the admin's own RLS-checked session is enough.
  const { error } = await supabase.from('orders').update({ status }).eq('id', orderId);
  if (error) {
    return {
      ok: false,
      error: `Could not update status: ${error.message}`,
      orderNumber: order.order_number,
    };
  }

  await recordAudit(admin, {
    action: 'order.status_changed',
    entityType: 'order',
    entityId: orderId,
    metadata: { order_number: order.order_number, from: order.status, to: status },
  });

  return {
    ok: true,
    message: `Order marked ${status.replace(/_/g, ' ')}.`,
    orderNumber: order.order_number,
  };
}

export async function updateOrderStatusAction(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();

  const parsed = updateStatusInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid status.' };
  }
  const { orderId, status } = parsed.data;

  const result = await applyOrderStatusChange(admin, orderId, status);
  if (result.orderNumber) revalidateOrderPaths(result.orderNumber);

  return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
}

const bulkUpdateStatusInput = z.object({
  orderIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one order.')
    .max(200, 'Select at most 200 orders at a time.'),
  status: orderStatusSchema,
});

/**
 * Applies one status to many orders at once, from the orders-list checkbox
 * selection.
 *
 * Runs sequentially rather than with Promise.all: `cancel_order` writes to
 * shared inventory rows, and running these one at a time keeps every other
 * order's outcome correct and independently reported even if one of them
 * fails partway through the batch — a partial success is reported honestly
 * ("8 updated; 2 could not be changed") rather than hidden behind a single
 * pass/fail result.
 */
export async function bulkUpdateOrderStatusAction(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();

  const parsed = bulkUpdateStatusInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { orderIds, status } = parsed.data;

  let succeeded = 0;
  let failed = 0;
  const touchedOrderNumbers: string[] = [];

  for (const orderId of orderIds) {
    const result = await applyOrderStatusChange(admin, orderId, status);
    if (result.orderNumber) touchedOrderNumbers.push(result.orderNumber);
    if (result.ok) succeeded += 1;
    else failed += 1;
  }

  for (const orderNumber of touchedOrderNumbers) revalidateOrderPaths(orderNumber);

  if (succeeded === 0) {
    return {
      ok: false,
      error: `Could not update any of the ${orderIds.length} selected order${orderIds.length === 1 ? '' : 's'}.`,
    };
  }

  const message =
    failed === 0
      ? `Updated ${succeeded} order${succeeded === 1 ? '' : 's'}.`
      : `Updated ${succeeded} order${succeeded === 1 ? '' : 's'}; ${failed} could not be changed (already cancelled, or no longer found).`;

  return { ok: true, message };
}

// ---------------------------------------------------------------------------
// Shipment / tracking
// ---------------------------------------------------------------------------

/**
 * Saves courier and tracking details and, on success, sends the shipping
 * email — brief §44's "Update Tracking" flow. The email step reuses
 * sendOrderEmail's claim-before-send guarantee, so an admin double-clicking
 * this button cannot cause a second email; see src/lib/email/send.ts.
 *
 * Never reports a silent success: the returned message always states plainly
 * whether the customer was actually notified, using describeOutcome().
 */
export async function updateShipmentTrackingAction(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();

  const parsed = shipmentSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, error: 'Please check the highlighted fields.', fieldErrors };
  }
  const { orderId, courierName, trackingId, trackingUrl } = parsed.data;

  const supabase = await createClient();

  const { data: order, error: readError } = await supabase
    .from('orders')
    .select(
      `order_number, status, subtotal_paise, discount_paise, shipping_paise, total_paise,
       customers ( name, email ),
       order_items ( product_name_snapshot, variant_name_snapshot, quantity, selling_price_paise_snapshot, subtotal_paise ),
       shipping_addresses ( address, city, state, postal_code, country )`,
    )
    .eq('id', orderId)
    .maybeSingle();

  if (readError || !order) {
    return { ok: false, error: 'Order not found.' };
  }

  if (order.status === 'cancelled') {
    return { ok: false, error: 'This order is cancelled and cannot be shipped.' };
  }

  const customer = order.customers as unknown as { name: string; email: string } | null;
  if (!customer) {
    return { ok: false, error: 'This order has no customer on record.' };
  }

  // Upsert: an admin correcting a typo in the tracking ID re-saves the same
  // row rather than failing on the one-shipment-per-order unique constraint.
  const { error: upsertError } = await supabase
    .from('shipments')
    .upsert(
      {
        order_id: orderId,
        courier_name: courierName,
        tracking_id: trackingId,
        tracking_url: trackingUrl || null,
      },
      { onConflict: 'order_id' },
    );

  if (upsertError) {
    return { ok: false, error: `Could not save tracking: ${upsertError.message}` };
  }

  // Saving tracking IS the shipping event (brief §72). Only moves the status
  // forward — an order already at shipped/out_for_delivery/delivered is left
  // alone, so correcting a tracking ID after the fact cannot walk the order
  // backward through its own timeline.
  const currentIndex = STATUS_SEQUENCE.indexOf(order.status);
  const shippedIndex = STATUS_SEQUENCE.indexOf('shipped');
  let statusBumped = false;

  if (currentIndex >= 0 && currentIndex < shippedIndex) {
    const { error } = await supabase.from('orders').update({ status: 'shipped' }).eq('id', orderId);
    if (!error) statusBumped = true;
  }

  await recordAudit(admin, {
    action: 'shipment.updated',
    entityType: 'order',
    entityId: orderId,
    metadata: { order_number: order.order_number, courier_name: courierName, tracking_id: trackingId, status_bumped_to_shipped: statusBumped },
  });

  revalidateOrderPaths(order.order_number);

  // ---- Shipping email -----------------------------------------------------
  const rawAddress = order.shipping_addresses as unknown as {
    address: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  } | null;

  const address = rawAddress
    ? {
        address: rawAddress.address,
        city: rawAddress.city,
        state: rawAddress.state,
        postalCode: rawAddress.postal_code,
        country: rawAddress.country,
      }
    : null;

  const items = (
    order.order_items as unknown as {
      product_name_snapshot: string;
      variant_name_snapshot: string;
      quantity: number;
      selling_price_paise_snapshot: number;
      subtotal_paise: number;
    }[]
  ).map((i) => ({
    productName: i.product_name_snapshot,
    variantName: i.variant_name_snapshot,
    quantity: i.quantity,
    sellingPricePaise: i.selling_price_paise_snapshot,
    subtotalPaise: i.subtotal_paise,
  }));

  const email = orderShippedEmail(
    {
      orderNumber: order.order_number,
      customerName: customer.name,
      items,
      subtotalPaise: order.subtotal_paise,
      discountPaise: order.discount_paise,
      shippingPaise: order.shipping_paise,
      totalPaise: order.total_paise,
      shippingAddress: address ?? {
        address: '',
        city: '',
        state: '',
        postalCode: '',
        country: 'India',
      },
      trackUrl: `${publicEnv.NEXT_PUBLIC_SITE_URL}/track-order?order=${encodeURIComponent(order.order_number)}`,
    },
    { courierName, trackingId, trackingUrl: trackingUrl || null },
  );

  const outcome = await sendOrderEmail({
    orderId,
    type: 'order_shipped',
    to: customer.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  return { ok: true, message: describeOutcome(outcome, 'Tracking saved.') };
}

// ---------------------------------------------------------------------------
// WhatsApp resend
// ---------------------------------------------------------------------------

const resendWhatsAppInput = z.object({ orderId: z.string().uuid() });

/**
 * Retries a WhatsApp order confirmation that failed. Consent is preserved by
 * requiring an existing whatsapp_order_confirmation log row: the checkout only
 * writes one for customers who ticked the opt-in box, so an order with no row
 * is never messaged from here. Delivery stays single-shot through the sender's
 * own claim-before-send, so a double click cannot send twice.
 */
export async function resendWhatsAppConfirmationAction(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();

  const parsed = resendWhatsAppInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid order.' };
  const { orderId } = parsed.data;

  const supabase = await createClient();

  const { data: order } = await supabase
    .from('orders')
    .select('order_number, total_paise, customers ( name, phone )')
    .eq('id', orderId)
    .maybeSingle();

  if (!order) return { ok: false, error: 'Order not found.' };

  const customer = order.customers as unknown as { name: string; phone: string | null } | null;
  if (!customer?.phone) {
    return { ok: false, error: 'This order has no phone number on record.' };
  }

  const { data: logs } = await supabase
    .from('notification_logs')
    .select('status')
    .eq('order_id', orderId)
    .eq('notification_type', 'whatsapp_order_confirmation');

  if (!logs || logs.length === 0) {
    return {
      ok: false,
      error: 'The customer did not opt in to WhatsApp for this order, so no message can be sent.',
    };
  }

  const outcome = await sendWhatsAppOrderConfirmation({
    orderId,
    orderNumber: order.order_number,
    phone: customer.phone,
    customerName: customer.name,
    totalPaise: order.total_paise,
  });

  await recordAudit(admin, {
    action: 'order.whatsapp_resent',
    entityType: 'order',
    entityId: orderId,
    metadata: { order_number: order.order_number, outcome: outcome.status },
  });

  revalidateOrderPaths(order.order_number);

  switch (outcome.status) {
    case 'sent':
      return { ok: true, message: 'WhatsApp confirmation sent.' };
    case 'duplicate':
      return { ok: true, message: 'A WhatsApp confirmation was already sent for this order.' };
    case 'skipped':
    case 'not_configured':
    case 'failed':
      return { ok: false, error: `WhatsApp message NOT sent — ${outcome.message}` };
  }
}

// ---------------------------------------------------------------------------

/** Every page that shows this order's status must be refreshed after a write. */
function revalidateOrderPaths(orderNumber: string) {
  revalidatePath('/admin');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderNumber}`);
  revalidatePath(`/account/orders/${orderNumber}`);
  revalidatePath('/account/orders');
}
