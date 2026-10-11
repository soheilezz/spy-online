// تنظیمات Firebase (کلید وب مخفی نیست و می‌تونه توی ریپو باشه)
export const firebaseConfig = {
  apiKey: "AIzaSyDQWIdIpno-NOOWE8WfASjMJl9Mbh6SgXU",
  authDomain: "spy-online-e4c24.firebaseapp.com",
  projectId: "spy-online-e4c24",
  storageBucket: "spy-online-e4c24.firebasestorage.app",
  messagingSenderId: "707207568924",
  appId: "1:707207568924:web:c4f4c323ebe14171f3c9d9"
};

// آدرس سایت بازی برای لینک دعوت (وقتی روی GitHub Pages گذاشتی اینجا بنویس).
// مثال: "https://soheilezz.github.io/spy-online"
// داخل اپ اندروید این لازمه، چون آدرس خود اپ قابل دعوت نیست.
export const WEB_URL = "https://soheilezz.github.io/spy-online";

// سرورهای اتصال صدا. STUN گوگل رایگانه و برای بیشتر وای‌فای‌ها کافیه.
// اگه روی اینترنت موبایل صدا وصل نشد، یه سرور TURN (مثلاً از metered.ca که پلن رایگان داره) اینجا اضافه کن:
// { urls: "turn:آدرس:3478", username: "...", credential: "..." }
export const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.relay.metered.ca:80"] },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "9b5bd4be8831e8ff62f4267e",
    credential: "f5alpFkYQtlGYHlL",
  },
  {
    urls: "turn:global.relay.metered.ca:80?transport=tcp",
    username: "9b5bd4be8831e8ff62f4267e",
    credential: "f5alpFkYQtlGYHlL",
  },
  {
    urls: "turn:global.relay.metered.ca:443",
    username: "9b5bd4be8831e8ff62f4267e",
    credential: "f5alpFkYQtlGYHlL",
  },
  {
    urls: "turns:global.relay.metered.ca:443?transport=tcp",
    username: "9b5bd4be8831e8ff62f4267e",
    credential: "f5alpFkYQtlGYHlL",
  },
];