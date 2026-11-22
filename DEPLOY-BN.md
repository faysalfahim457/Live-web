# WebCollector Studio — Node সংস্করণ (আসল ব্রাউজার) চালানোর নিয়ম

এটি সার্ভারে একটি **আসল Chromium ব্রাউজার** চালায়। লিংক দিলে ডিসপ্লেতে ব্রাউজারটি খোলে; আপনি ক্লিক, scroll, টাইপ করে স্বাভাবিকভাবে ঘুরবেন, আর যে পেজে যাবেন (এবং scroll করলে lazy-load হওয়া ফাইলসহ) সব সংগ্রহ হতে থাকবে। শেষে Download ZIP।

> InfinityFree/সাধারণ PHP হোস্টিংয়ে এটা চলে না। Docker চালানো যায় এমন জায়গা লাগবে।

## পথ ১ — নিজের কম্পিউটারে (সবচেয়ে নিশ্চিত)
1. Node.js 22+ ইনস্টল করুন।
2. এই ফোল্ডারে টার্মিনাল খুলে:
   ```
   npm install
   npx playwright install chromium
   node server.js
   ```
3. ব্রাউজারে `http://127.0.0.1:3000` খুলুন।

## পথ ২ — Hugging Face Spaces (ফ্রি Docker হোস্ট) — আমি এটিতে চালিয়ে দেখিনি
1. huggingface.co-তে অ্যাকাউন্ট খুলুন → **New Space** → SDK: **Docker** → Blank → Create।
2. Space-এর **Files** ট্যাবে এই ফোল্ডারের সব ফাইল আপলোড করুন (`Dockerfile`, `README.md`, `server.js`, `package.json`, `src/`, `public/`)।
3. Build শেষ হলে চালু হবে (প্রথমবার কয়েক মিনিট)।
4. **গুরুত্বপূর্ণ:** huggingface.co পেজের ভেতরে না দেখে, সরাসরি অ্যাপের ঠিকানা খুলুন: `https://ইউজারনেম-স্পেসনাম.hf.space` (Space-এর ⋮ মেনু → "Embed this Space" থেকে পাবেন)। ভেতরে ফ্রেমে কুকি আটকে যেতে পারে।
5. ফ্রি টিয়ারে কিছুক্ষণ ব্যবহার না করলে Space ঘুমিয়ে যায় (আবার খুললে জাগে) এবং মেমরি সীমিত — একসাথে ২টির বেশি সেশন চালাবেন না।

সম্ভাব্য সমস্যা (যাচাই করা নেই): Chromium sandbox ছাড়া চলছে (`CHROMIUM_NO_SANDBOX=true`), তাই শুধু নিজের/অনুমতিপ্রাপ্ত সাইটে ব্যবহার করুন; ফ্রি হোস্টের শর্তে এমন টুল বারণ থাকতে পারে।

## পথ ৩ — নিজের VPS
`docker build -t webcollector . && docker run -p 10000:10000 --security-opt seccomp=unconfined webcollector`, তারপর `http://সার্ভার-IP:10000`। HTTPS-এর জন্য nginx/Caddy ব্যবহার করুন (`TRUST_PROXY=true` আগে থেকেই দেওয়া)।

## ব্যবহার
URL দিন → Start → ডিসপ্লেতে ব্রাউজার খোলে → স্বাভাবিকভাবে ঘুরুন → ডানের তালিকায় ফাইল ও পেজ বাড়তে থাকে → **Download ZIP**। নতুন কাজের জন্য **Replace / New Collection** (সব ফাইল মুছে যায়)।

আইনি/নৈতিক: শুধু নিজের বা অনুমতি আছে এমন সাইট সংগ্রহ করুন।

## পথ ৪ — GitHub + Render (ফ্রি) — আমি এটিতে চালিয়ে দেখিনি
1. GitHub-এ নতুন repository খুলুন (Private রাখাই ভালো) এবং এই ফোল্ডারের সব ফাইল আপলোড করুন (`Dockerfile`, `render.yaml`, `server.js`, `package.json`, `src/`, `public/`)।
2. render.com-এ GitHub দিয়ে সাইন-আপ → **New → Web Service** → ঐ repository বাছুন → Language/Runtime: **Docker** → Instance type: **Free** → Deploy।
3. Build শেষে Render একটি `https://….onrender.com` ঠিকানা দেবে — ওটা খুলুন।
সীমা: ১৫ মিনিট কেউ না ঢুকলে সার্ভিস ঘুমিয়ে যায় (আবার খুললে ~১ মিনিট লাগে এবং চলমান সংগ্রহ হারায়); মাসে ৭৫০ ঘণ্টা; ফ্রি প্ল্যানের RAM কম হওয়ায় Chromium ক্র্যাশ করতে পারে — তখন Render-এর পেইড প্ল্যান (বেশি RAM) লাগবে।

## আপডেট (নতুন)
- **Download → "Host-ready Site (original paths)"**: ফাইলগুলো সাইটের আসল পথে সাজানো (যেমন `/m/app.js` → `m/app.js`), পেজ `m/home/index.html`-এ। এই ফোল্ডারের ভেতরের জিনিস হোস্টের **root**-এ (public_html/htdocs) আপলোড করলে সাইট চলবে। "Complete Project ZIP"-এও এটা `site/` ফোল্ডারে থাকে; ধরন অনুযায়ী (css/js/images/fonts) সাজানো কপি `original/assets/`-এ থাকে।
- **Lazy chunk আবিষ্কার**: Webpack সাইটের (`/m/…chunk.js`) যে ফাইলগুলো ব্রাউজার এখনো চায়নি, রানটাইমের তালিকা পড়ে সেগুলোও নিজে সংগ্রহ করে।
- ছোট সার্ভারের জন্য ব্রাউজার স্ট্রিম হালকা করা হয়েছে (Dockerfile-এ `SCREENCAST_QUALITY=45`, `SCREENCAST_EVERY_NTH=2`, `MAX_CONCURRENT_COLLECT=3`)।


## ফাইল গঠন (আপডেট)
- `index.html` এখন **মেইন ফোল্ডারে**; CSS/JS/আইকন `public/` ফোল্ডারে (`public/app.css`, `public/app.js`) এবং index থেকে ওই পথেই লিংক করা।
- `server.js` এখন `src/` এর সব মডিউল ব্যবহার করে (সেশন, প্রক্সি, ZIP, প্রিভিউ, ফেইলড-রিট্রাই)।
- টেস্ট: `npm test` (Chromium ও `unzip` লাগে)।
