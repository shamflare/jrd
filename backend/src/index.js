import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import itemsRouter from './routes/items.js';
import logRouter from './routes/log.js';
import inventoryRouter from './routes/inventory.js';
import settingsRouter from './routes/settings.js';
import photosRouter from './routes/photos.js';
import apiConfigsRouter from './routes/apiConfigs.js';
import bankRouter, { smsWebhookHandler } from './routes/bank.js';
import internalRouter from './routes/internal.js';
import monthlyRouter from './routes/monthly.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import pricesRouter from './routes/prices.js';
import kontorCompareRouter from './routes/kontorCompare.js';
import otpPublicRouter from './routes/otp.js';
import otpSourceRouter from './routes/otpSource.js';
import { requireAuth, requireAdmin, optionalAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Serve uploaded photos (مفتوحة للقراءة بدون auth لأن src في <img> لا يحمل cookie تلقائياً عبر CORS).
// المسارات تحت /uploads/t<id>/... فهي قابلة للتخمين فقط لمن يعرف tenant_id + filename UUID.
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// Healthcheck
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// مسارات عامّة قبل auth:
//   - /api/auth/*   : login/logout/me (الـ login لا يملك كوكي بعد)
//   - /api/internal : محمي بـ INTERNAL_API_KEY داخلياً (للبوت/scrapers)
//   - /api/webhooks/bank-sms : webhook خارجي محمي بـ SMS_WEBHOOK_SECRET في URL
app.use('/api/auth', authRouter);
// optionalAuth: يضع req.user إن وجد cookie صحيح — حتّى تستطيع internal routes
// التي تستدعيها الواجهة أن تحدد tenant_id تلقائياً من المستخدم.
// البوت/scrapers يستخدمون X-Internal-Api-Key (لا cookie) ويمرّرون tenant_id في body.
app.use('/api/internal', optionalAuth, internalRouter);
app.post('/api/webhooks/bank-sms/:tenantSecret', smsWebhookHandler);
// التوافق مع URL القديم — يستخدم SMS_WEBHOOK_SECRET العام (سيُلغى في المرحلة 10 بعد تحديث SMS Forwarder).
app.post('/api/bank/sms-webhook', smsWebhookHandler);

// سجلّ أكواد OTP لأكبنك — عامّ عمداً بلا تسجيل دخول (صفحة /islam).
// لا ينتمي لأي مستأجر ولا يكشف أي بيانات أخرى: قراءة الأكواد + تفريغ السجل فقط.
app.use('/api/public/otp', otpPublicRouter);

// كل ما تحت /api بعد هذه النقطة يتطلّب login (cookie أو Bearer).
app.use('/api', requireAuth);
app.use('/api/admin', requireAdmin, adminRouter); // requireAdmin داخلياً يستدعي requireAuth، لكن وضعناه صراحةً للوضوح.
app.use('/api/items', itemsRouter);
app.use('/api/log', logRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/configs', apiConfigsRouter);
app.use('/api/bank', bankRouter);
app.use('/api/monthly', monthlyRouter);
app.use('/api/prices', pricesRouter);
app.use('/api/kontor', kontorCompareRouter);
// إدارة/إقران سكرابر أكبنك (يعرض متصفّح السيرفر) — خلف تسجيل الدخول.
app.use('/api/otp-source', otpSourceRouter);

// Serve frontend static files in production
const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(frontendPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
