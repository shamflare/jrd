#!/bin/sh
set -e

# Railway يضبط PORT لـ backend (الخدمة العامة).
# البوت يحتاج معرفة هذا المنفذ ليتصل بـ backend داخلياً.
BACKEND_PORT="${PORT:-3001}"
export BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"

echo "Starting backend on port ${BACKEND_PORT}..."
node backend/src/index.js &
BACKEND_PID=$!

# انتظر أن يصبح backend جاهزاً قبل تشغيل البوت
echo "Waiting for backend to be ready..."
for i in $(seq 1 30); do
  if wget -q --spider "http://127.0.0.1:${BACKEND_PORT}/api/items" 2>/dev/null \
     || wget -q --spider "http://127.0.0.1:${BACKEND_PORT}/" 2>/dev/null; then
    echo "Backend is ready"
    break
  fi
  sleep 1
done

# --- Supervised loops للخدمات الثانوية ---
# لو ماتت الخدمة لأيّ سبب، نُعيد تشغيلها بعد 5 ثوانٍ. هذا يمنع
# الحالة التي شوهدت سابقاً: bot يموت بصمت → frontend يُظهر "bot_unreachable".
supervise() {
  name="$1"
  shift
  # نُعطّل set -e داخل الـ loop حتى نتمكّن من التقاط exit code وإعادة المحاولة
  set +e
  while true; do
    echo "[supervise:$name] starting: $*"
    "$@"
    rc=$?
    echo "[supervise:$name] exited with code $rc — restarting in 5s"
    sleep 5
  done
}

supervise bot  node bot/src/index.js &
BOT_SUP_PID=$!

supervise gmsg node messages-scraper/src/index.js &
GMSG_SUP_PID=$!

# ملاحظة: أكواد أكبنك (صفحة /islam) تُقرأ من نفس نسخة gmsg أعلاه — تتناوب
# على محادثتَي KUVEYT TURK و CEPSIFRE في الجلسة المقترنة نفسها، فلا نسخة
# ثانية ولا إقران آخر. للتعطيل: GMSG_OTP_CONTACTS= (فارغة).

echo "All services started (backend=$BACKEND_PID, bot-sup=$BOT_SUP_PID, gmsg-sup=$GMSG_SUP_PID)"

# نُبقي backend في المقدّمة: لو سقط، تموت الحاوية ويُعيد Railway تشغيلها.
wait $BACKEND_PID
backend_rc=$?
echo "Backend exited with code $backend_rc — shutting down supervisors"
kill $BOT_SUP_PID $GMSG_SUP_PID 2>/dev/null || true
exit $backend_rc
