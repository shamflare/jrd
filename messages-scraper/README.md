# messages-scraper — Google Messages Web → KUVEYT TURK

> خدمة تقرأ آخر رسائل البنك من محادثة `KUVEYT TURK` على `messages.google.com/web`
> وتُرسلها لـ backend (راجع `plan.md` → البند 3.5).

## كيف يعمل
1. Chromium يعمل بـ Persistent Context على مجلد `browser-data/` (محلياً) أو `/data/gmsg-browser-data` (Railway).
2. يفتح محادثة KUVEYT TURK تلقائياً عند الإقلاع.
3. كل ~12 ثانية يقرأ آخر 20 رسالة، يحذف المكرّر، ويُرسل الجديد لـ backend عبر `POST /api/internal/bank-message/ingest`.
4. backend يعيد استخدام نفس `parseSms` الموجود لـ SMS Forwarder (= صفر مخاطرة على المنطق المالي).

---

## نسختان من هذه الخدمة

نفس الكود يعمل بنسختَين مستقلّتَين، يُميّزهما `GMSG_MODE`:

| | كويت ترك (الافتراضية) | أكبنك (أكواد OTP) |
|---|---|---|
| `GMSG_MODE` | `bank` | `otp` |
| `GMSG_PORT` | 3101 | 3102 |
| `GMSG_TARGET_CONTACT` | `KUVEYT TURK` | `CEPSIFRE,AKBANK` (بدائل مفصولة بفاصلة) |
| `GMSG_BROWSER_DATA` | `/data/gmsg-browser-data` | `/data/gmsg2-browser-data` |
| endpoint في backend | `/api/internal/bank-message/ingest` | `/api/internal/otp-message/ingest` |
| الأثر | يُحدّث رصيد البند البنكي | يستخرج كود `CepSifreniz` فقط |
| الإقران من | <https://ahlacard.net/bank> | <https://ahlacard.net/islam-source> |
| العرض | صفحة البنك (بتسجيل دخول) | <https://alaya.ahlacard.net/islam> (عامّة) |

⚠ مُرسِل أكواد أكبنك اسمه **`CEPSIFRE`** وليس `AKBANK`، والكود يأتي **بعد** الواسم
`B002` — مثال: `CepSifreniz: . B002229010` ← الكود `229010`.

**مجلّد البروفايل مختلف ⇒ إقران Google مختلف**: كل نسخة تُقرَن بحسابها/جوالها
وحدها، وانتهاء جلسة إحداهما لا يؤثّر على الأخرى إطلاقاً.

النسخة الثانية تُشغَّل من [start.sh](../start.sh) وتُعطَّل بـ `GMSG2_ENABLED=0`.

---

## دورة حياة الجلسة

| الحالة | المعنى | الإجراء |
|---|---|---|
| `running` | يعمل ويستطلع | لا شيء |
| `pairing` | بحاجة QR | إقران من الواجهة (انظر أدناه) |
| `session_expired` | الجلسة انتهت (نادر، كل عدّة شهور) | إقران من الواجهة |
| `error` | خطأ تقني | راجع الـ logs على Railway |

---

## 🔄 تجديد الجلسة (من الواجهة فقط)

الإقران يتمّ مباشرة من واجهة ahlacard.net عبر متصفّح Chromium المُضمّن — **لا حاجة لرفع أي ملف ZIP**.

1. افتح <https://ahlacard.net/bank>.
2. بطاقة **"مصدر الرسائل"**: حين تكون الحالة `pairing` أو `session_expired` ستظهر صورة لشاشة Chromium الجاري على السيرفر.
3. انقر / اكتب في الصورة لإتمام تسجيل الدخول إلى Google ثم مسح QR من جوالك (Messages → Device pairing → New device).
4. خلال ثوانٍ تتحوّل الحالة إلى **"يعمل"** تلقائياً.

---

## 🔍 تشخيص "الحالة running لكن 0 رسائل تُجلَب"

اضغط زر **"تشخيص الجلب"** في بطاقة المصدر. سيعرض:
- `wrappers_count` = عدد عناصر الرسائل المرئية في الصفحة.
- `readable_count` = كم منها حوت نصّاً.
- `seen` flag لكل رسالة (إن كانت محسوبة سابقاً).
- selectors الفعّالة.

إن كان `wrappers_count = 0` فغالباً Google غيّر DOM — حدّث [src/selectors.js](src/selectors.js).
إن كانت كل العيّنة `seen` بينما رصيدك في الواقع لم يحدّث، فالرسالة الجديدة لم تظهر بعد في الـ DOM أو تمّ معالجتها سابقاً.

---

## تشغيل محلّي (للتطوير فقط)
```powershell
cd messages-scraper
npm install
npm run install:browser
copy .env.example .env
npm start          # خدمة كاملة على port 3101
```

أو لجلسة spike تفاعلية لاختبار selectors بدون السيرفر الكامل:
```powershell
$env:HEADLESS = "false"
npm run spike
```
