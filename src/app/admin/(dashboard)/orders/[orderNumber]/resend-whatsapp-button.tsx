'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { resendWhatsAppConfirmationAction } from '@/server/actions/order-actions';

export function ResendWhatsAppButton({ orderId }: { orderId: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setResult(null);
    const res = await resendWhatsAppConfirmationAction({ orderId });
    setResult(res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error });
    setSubmitting(false);
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <Button type="button" size="sm" variant="outline" onClick={handleClick} disabled={submitting}>
        {submitting ? 'Sending…' : 'Resend WhatsApp confirmation'}
      </Button>
      {result ? (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={cn('mt-2 text-sm leading-relaxed', result.ok ? 'text-green-700' : 'text-[--color-danger]')}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
