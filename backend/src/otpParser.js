/**
 * otpParser — استخراج كود الـ OTP (CepSifre) من رسائل AKBANK.
 *
 * نموذج الرسالة المستهدَف:
 *   PARA CIKISI: 0034-0361082 hesaptan AKBANK T. 1268-TR590004601268888000382460
 *   nolu hesaba 10.000,00 TL gondermek icin 03 nolu CepSifreniz: 229010. B002
 *
 * المطلوب: 229010
 *
 * ملاحظة مهمّة: لا نلتقط أي رقم في النصّ — نشترط أن يسبقه أحد ألفاظ
 * "الشِّفرة/الكود" التركية، وإلا التقطنا أرقام الحساب أو المبلغ.
 * (`1268` في المثال أعلاه يسبقه "AKBANK T." وليس "sifre" فلا يُلتقط.)
 */

// تطبيع الحروف التركية كي تعمل الـ regex على "Şifreniz" و "Sifreniz" و "şıfre" معاً.
function normalizeTr(s) {
  return String(s || '')
    .replace(/[şŞ]/g, 's')
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .toLowerCase();
}

// الأنماط مرتّبة بالأولوية: الأدقّ أوّلاً.
// كلّها تُطبَّق على النصّ المُطبَّع (lowercase + بلا حروف تركية خاصّة).
const PATTERNS = [
  // "03 nolu CepSifreniz: 229010"  /  "CepSifreniz 229010"
  /cep\s*sifr(?:e|eniz|niz)?\s*[:\-]?\s*(\d{4,10})\b/,
  // "Islem Sifreniz: 123456" / "Sifreniz: 123456" / "Sifre: 123456"
  /(?:islem\s*)?sifr(?:e|eniz|niz)\s*[:\-]?\s*(\d{4,10})\b/,
  // "Dogrulama kodunuz: 123456" / "Guvenlik kodu: 123456" / "Onay kodu 123456"
  /(?:dogrulama|guvenlik|onay|islem|tek\s*kullanimlik)\s*kod(?:u|unuz|unuz)?\s*[:\-]?\s*(\d{4,10})\b/,
  // "kodunuz: 123456" (عامّ — آخر ملاذ قبل الفشل)
  /kod(?:u|unuz)\s*[:\-]?\s*(\d{4,10})\b/,
];

/**
 * @param {string} text نصّ الرسالة الخام
 * @returns {{ code: string } | null}
 */
export function parseOtpCode(text) {
  if (!text || typeof text !== 'string') return null;
  const norm = normalizeTr(text);
  for (const re of PATTERNS) {
    const m = norm.match(re);
    if (m && m[1]) return { code: m[1] };
  }
  return null;
}

/**
 * فلتر المُرسِل: نقبل فقط ما يبدو أنه من أكبنك.
 * يُطبَّق على اسم جهة الاتصال أو نصّ الرسالة (بعض الرسائل تحوي AKBANK في المتن).
 * سلوك متساهل عمداً: لو لم نعرف اسم جهة الاتصال نعتمد على النصّ.
 */
export function looksLikeAkbank({ contactName = '', text = '' } = {}) {
  return /akbank/i.test(normalizeTr(contactName)) || /akbank/i.test(normalizeTr(text));
}

export default { parseOtpCode, looksLikeAkbank };
