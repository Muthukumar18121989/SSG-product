import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { PaymentStatusBadge } from '@/components/admin/payment-status-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { OrderDetailCard, type OrderDetailData } from '@/components/order/order-detail-card';
import { formatPaise } from '@/lib/money';
import { createClient } from '@/lib/supabase/server';
import type { NotificationType, OrderStatus, PaymentStatus } from '@/lib/database.types';

import { OrderStatusForm } from './order-status-form';
import { ResendWhatsAppButton } from './resend-whatsapp-button';
import { TrackingForm } from './tracking-form';

export const dynamic = 'force-dynamic';

type Raw = {
  id: string;
  order_number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_provider: string | null;
  payment_reference: string | null;
  razorpay_order_id: string | null;
  notes: string | null;
  created_at: string;
  subtotal_paise: number;
  discount_paise: number;
  shipping_paise: number;
  total_paise: number;
  customers: { name: string; email: string; phone: string | null } | null;
  order_items: {
    product_name_snapshot: string;
    variant_name_snapshot: string;
    quantity: number;
    selling_price_paise_snapshot: number;
    subtotal_paise: number;
  }[];
  shipping_addresses: {
    name: string;
    address: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  } | null;
  shipments: {
    courier_name: string;
    tracking_id: string;
    tracking_url: string | null;
    shipped_at: string;
  } | null;
};

type NotificationRow = {
  notification_type: NotificationType;
  status: 'sent' | 'failed';
  recipient: string;
  sent_at: string | null;
  created_at: string;
  error_message: string | null;
};

const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  order_confirmation: 'Order confirmation',
  order_shipped: 'Shipping notification',
  order_status_updated: 'Status update',
  whatsapp_order_confirmation: 'WhatsApp order confirmation',
};

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('orders')
    .select(
      `id, order_number, status, payment_status, payment_provider, payment_reference,
       razorpay_order_id, notes, created_at, subtotal_paise, discount_paise, shipping_paise, total_paise,
       customers ( name, email, phone ),
       order_items ( product_name_snapshot, variant_name_snapshot, quantity, selling_price_paise_snapshot, subtotal_paise ),
       shipping_addresses ( name, address, city, state, postal_code, country ),
       shipments ( courier_name, tracking_id, tracking_url, shipped_at )`,
    )
    .eq('order_number', orderNumber.toUpperCase())
    .maybeSingle();

  if (error || !data) notFound();

  const order = data as unknown as Raw;

  // A second query, once the order's id is known — notification_logs has no
  // FK back to orders.order_number to filter on directly in the first query.
  const { data: notificationRows } = await supabase
    .from('notification_logs')
    .select('notification_type, status, recipient, sent_at, created_at, error_message')
    .eq('order_id', order.id)
    .order('created_at', { ascending: false });

  const customer = order.customers;

  // A WhatsApp row only exists for customers who opted in, so its presence is
  // the consent check; resending is offered only while none has been delivered.
  const whatsappRows = ((notificationRows ?? []) as unknown as NotificationRow[]).filter(
    (n) => n.notification_type === 'whatsapp_order_confirmation',
  );
  const canResendWhatsApp =
    whatsappRows.length > 0 && !whatsappRows.some((n) => n.status === 'sent');

  const detail: OrderDetailData = {
    orderNumber: order.order_number,
    status: order.status,
    placedAt: order.created_at,
    subtotalPaise: order.subtotal_paise,
    discountPaise: order.discount_paise,
    shippingPaise: order.shipping_paise,
    totalPaise: order.total_paise,
    items: order.order_items.map((i) => ({
      productName: i.product_name_snapshot,
      variantName: i.variant_name_snapshot,
      quantity: i.quantity,
      pricePaise: i.selling_price_paise_snapshot,
      subtotalPaise: i.subtotal_paise,
    })),
    shippingAddress: order.shipping_addresses
      ? {
          name: order.shipping_addresses.name,
          address: order.shipping_addresses.address,
          city: order.shipping_addresses.city,
          state: order.shipping_addresses.state,
          postalCode: order.shipping_addresses.postal_code,
          country: order.shipping_addresses.country,
        }
      : null,
    shipment: order.shipments
      ? {
          courierName: order.shipments.courier_name,
          trackingId: order.shipments.tracking_id,
          trackingUrl: order.shipments.tracking_url,
          shippedAt: order.shipments.shipped_at,
        }
      : null,
  };

  return (
    <div>
      <Link
        href="/admin/orders"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-green-800"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All orders
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-earth-900">
            {order.order_number}
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            Placed{' '}
            {new Date(order.created_at).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={order.status} />
          <PaymentStatusBadge status={order.payment_status} />
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <OrderDetailCard order={detail} />

          <section aria-labelledby="notifications-heading" className="rounded-2xl border border-line bg-white p-6">
            <h2 id="notifications-heading" className="font-display text-base font-semibold text-earth-900">
              Notifications
            </h2>
            {!notificationRows || notificationRows.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No emails sent for this order yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {(notificationRows as unknown as NotificationRow[]).map((n, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="text-stone-700">
                      {NOTIFICATION_LABELS[n.notification_type]}
                      <span className="ml-2 text-xs text-stone-400">to {n.recipient}</span>
                    </span>
                    <span
                      className={
                        n.status === 'sent'
                          ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800'
                          : 'rounded-full bg-[--color-danger-surface] px-2 py-0.5 text-xs font-medium text-[--color-danger]'
                      }
                      title={n.error_message ?? undefined}
                    >
                      {n.status === 'sent' ? 'Sent' : 'Failed'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canResendWhatsApp ? <ResendWhatsAppButton orderId={order.id} /> : null}
          </section>
        </div>

        <div className="space-y-6">
          <section aria-labelledby="customer-heading" className="rounded-2xl border border-line bg-white p-6">
            <h2 id="customer-heading" className="font-display text-base font-semibold text-earth-900">
              Customer
            </h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div>
                <dt className="sr-only">Name</dt>
                <dd className="font-medium text-earth-900">{customer?.name ?? '—'}</dd>
              </div>
              <div>
                <dt className="sr-only">Email</dt>
                <dd className="text-stone-600">{customer?.email ?? '—'}</dd>
              </div>
              {customer?.phone ? (
                <div>
                  <dt className="sr-only">Phone</dt>
                  <dd className="text-stone-600">{customer.phone}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section aria-labelledby="payment-heading" className="rounded-2xl border border-line bg-white p-6">
            <h2 id="payment-heading" className="font-display text-base font-semibold text-earth-900">
              Payment
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Status"><PaymentStatusBadge status={order.payment_status} /></Row>
              <Row label="Amount">{formatPaise(order.total_paise)}</Row>
              {order.payment_provider ? <Row label="Provider">{order.payment_provider}</Row> : null}
              {order.payment_reference ? (
                <Row label="Payment ID">
                  <span className="break-all font-mono text-xs">{order.payment_reference}</span>
                </Row>
              ) : null}
              {order.razorpay_order_id ? (
                <Row label="Razorpay order">
                  <span className="break-all font-mono text-xs">{order.razorpay_order_id}</span>
                </Row>
              ) : null}
            </dl>
            {order.payment_status === 'paid' ? (
              <p className="mt-4 text-xs leading-relaxed text-stone-500">
                Refunds are not automated. To refund this order, process it directly in the{' '}
                <a
                  href="https://dashboard.razorpay.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-800 hover:underline"
                >
                  Razorpay dashboard
                </a>
                .
              </p>
            ) : null}
          </section>

          <section aria-labelledby="status-heading" className="rounded-2xl border border-line bg-white p-6">
            <h2 id="status-heading" className="font-display text-base font-semibold text-earth-900">
              Order status
            </h2>
            <OrderStatusForm orderId={order.id} currentStatus={order.status} />
          </section>

          <section aria-labelledby="tracking-heading" className="rounded-2xl border border-line bg-white p-6">
            <h2 id="tracking-heading" className="font-display text-base font-semibold text-earth-900">
              Courier &amp; tracking
            </h2>
            <TrackingForm
              orderId={order.id}
              disabled={order.status === 'cancelled'}
              initial={
                order.shipments
                  ? {
                      courierName: order.shipments.courier_name,
                      trackingId: order.shipments.tracking_id,
                      trackingUrl: order.shipments.tracking_url ?? '',
                    }
                  : null
              }
            />
          </section>

          {order.notes ? (
            <section aria-labelledby="notes-heading" className="rounded-2xl border border-line bg-white p-6">
              <h2 id="notes-heading" className="font-display text-base font-semibold text-earth-900">
                Notes from customer
              </h2>
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-stone-600">
                {order.notes}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium text-earth-900">{children}</dd>
    </div>
  );
}
