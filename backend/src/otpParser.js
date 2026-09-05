/**
 * otpParser — استخراج كود الـ OTP (CepSifre) من رسائل أكبنك.
 *
 * المُرسِل هو الرمز القصير `CEPSIFRE` (وليس AKBANK)، والصيغة الفعلية:
 *
 *   PARA CIKISI: 0034-0361082 hesaptan AKBANK T. 1268-TR59000460126888800038
 *   2460 nolu hesaba 10.000,00 TL gondermek icin 03 nolu CepSifreniz: . B002229010
 *
 * المطلوب: 229010 — أي أن الكود يأتي **بعد** الواسم `B002`، لا مباشرة بعد
 * النقطتين. ورأينا كذلك صيغة يسبق فيها الكودُ الواسمَ (`CepSifreniz: 229010. B002`)،
 * فنقبل الترتيبين.
 *
 * مبدأ الأمان: لا نبحث عن الأرقام إلا في ما **بعد** لفظ الشِّفرة، فيستحيل أن
 * نلتقط رقم الحساب أو IBAN أو المبلغ لأنّها كلّها تسبقه في الرسالة.
 */

// تطبيع الحروف التركية كي تعمل الـ regex على "Şifreniz" و "Sifreniz" معاً.
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

// ألفاظ "الشِّفرة/الكود" مرتّبة بالأولوية — الأدقّ أوّلاً.
const KEYWORDS = [
  /cep\s*sifre(?:niz)?/,
  /(?:islem\s*)?sifre(?:si|niz)?/,
  /(?:dogrulama|guvenlik|onay|tek\s*kullanimlik)\s*kod(?:u|unuz)?/,
  /kod(?:u|unuz)/,
];

// واسم نهاية رسائل أكبنك: حرف B يليه ثلاثة أرقام (B002). يُحذف قبل قراءة
// الكود وإلّا التقطنا `002` بدل `229010` في `B002229010`.
const MARKER = /\bb\d{3}/g;

/**
 * @param {string} text نصّ الرسالة الخام
 * @returns {{ code: string } | null}
 */
export function parseOtpCode(text) {
  if (!text || typeof text !== 'string') return null;
  const norm = normalizeTr(text);

  for (const kw of KEYWORDS) {
    const m = norm.match(kw);
    if (!m) continue;
    // ما بعد اللفظ فقط — يستبعد رقم الحساب والمبلغ لأنّهما قبله.
    const tail = norm.slice(m.index + m[0].length).replace(MARKER, ' ');
    const hit = tail.match(/(\d{4,10})/);
    // الكود قد يبدأ بصفر (مثل 035511) فنُبقيه نصّاً ولا نحوّله لعدد أبداً.
    if (hit) return { code: hit[1] };
  }
  return null;
}

/**
 * فلتر المُرسِل — دفاع في العمق فقط؛ الحماية الفعلية هي INTERNAL_API_KEY
 * وكون السكرابر لا يفتح سوى محادثة واحدة.
 *
 * يعتمد على اسم المُرسِل لا على متن الرسالة: بعض رسائل CEPSIFRE تخصّ تحويلاً
 * إلى بنك آخر (مثل TURKIYE IS BNK) فلا تذكر AKBANK إطلاقاً، وكان اشتراط
 * ذكرها يُسقط أكواداً صحيحة.
 */
const DEFAULT_SENDERS = 'cepsifre,akbank';

export function isOtpSender({ contactName = '', text = '' } = {}) {
  const name = normalizeTr(contactName).trim();
  const body = normalizeTr(text);
  const allowed = (process.env.OTP_ALLOWED_SENDERS || DEFAULT_SENDERS)
    .split(',')
    .map((s) => normalizeTr(s).trim())
    .filter(Boolean);

  if (name && allowed.some((a) => name.includes(a))) return true;
  // اسم المُرسِل قد يصل خاطئاً أو فارغاً (مثلاً لو أخفق تبديل المحادثة في
  // السكرابر). لا يجوز أن يُسقط ذلك كوداً صحيحاً، فنقبل كذلك متناً يحمل لفظ
  // CepSifre — وهو ما يشترطه المحلّل نفسه بعد قليل على أي حال.
  return /cep\s*sifre|sifreniz|sifresi/.test(body);
}

export default { parseOtpCode, isOtpSender };
