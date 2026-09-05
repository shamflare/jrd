import { config } from './config.js';
import { log } from './logger.js';

/**
 * يُرسل رسالة خام من Google Messages إلى backend.
 * backend يتولّى الـ parsing (نفس parser SMS الحالي لكويت ترك)
 * والـ dedup (جدول bank_message_seen).
 */
export async function sendToBackend({ text, occurredAt, externalId, contactName }) {
  const endpoint = config.mode === 'otp' ? 'otp-message' : 'bank-message';
  const url = `${config.backendUrl.replace(/\/$/, '')}/api/internal/${endpoint}/ingest`;
  const body = {
    source: 'gmsg',
    // tenant_id يُتجاهَل في وضع otp (سجلّ الأكواد لا ينتمي لأي مستأجر).
    tenant_id: config.tenantId,
    contact_name: contactName || config.targetContact,
    text,
    occurred_at: occurredAt || null,   // وقت ظاهر في الرسالة (تقريبي)
    external_id: externalId || null,   // hash مستقر للرسالة، يُستخدم لـ dedup
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey || '',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    log.warn('backend', `ingest http=${r.status}`, data);
    const err = new Error(`backend_ingest_${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}
