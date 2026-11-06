// Báo giá vé Vietravel Airlines: Hà Nội (HAN) -> Nha Trang (CXR), 19/11/2026, chuyến 07:15
// Chạy 1 lần:      node check-fare.mjs --once
// Chạy liên tục:   node check-fare.mjs            (mỗi 30 phút, tự dừng khi tới ngày bay)
// Xem trình duyệt: thêm --headed
// Thử gửi Telegram: node check-fare.mjs --test-telegram
// Telegram: đặt biến môi trường TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const CFG = {
  from: 'HAN',
  to: 'CXR',
  date: '2026-11-19',
  time: '07:15',
  maxPrice: 1_100_000, // mốc đánh dấu 🔥 khi TỔNG SỐ TIỀN (gồm thuế, phí) <= mức này; lần nào cũng gửi báo giá
  intervalMin: 30,
};

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const HEADED = args.includes('--headed');
const here = (f) => new URL(f, import.meta.url).pathname;
fs.mkdirSync(here('./debug/'), { recursive: true });
const STATE = here('./state.json');

const fmt = (n) => n.toLocaleString('vi-VN') + 'đ';
const log = (...a) => {
  const line = `[${new Date().toLocaleString('vi-VN')}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(here('./history.log'), line + '\n');
};
// Gửi Telegram nếu có TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; trên Mac hiện thêm thông báo hệ thống
async function notify(title, msg) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const fail = (why) => {
    log('Gửi Telegram lỗi:', why);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Telegram::${why}`);
    process.exitCode = 1; // workflow hiện đỏ để dễ thấy
  };
  if (!token || !chatId) {
    if (process.env.GITHUB_ACTIONS) {
      fail(`Thiếu secret: ${[!token && 'TELEGRAM_BOT_TOKEN', !chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean).join(', ')}`);
    }
  } else {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `✈️ ${title}\n${msg}` }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) fail(`Telegram trả lỗi ${res.status}: ${body.description || res.statusText}`);
      else log('Đã gửi Telegram');
    } catch (e) {
      fail(e.message);
    }
  }
  if (process.platform === 'darwin') {
    const esc = (s) => s.replace(/["'\\]/g, '');
    try {
      execSync(`osascript -e 'display notification "${esc(msg)}" with title "${esc(title)}" sound name "Glass"'`);
    } catch { /* bỏ qua */ }
  }
}
// "VND 1,925,000.00" -> 1925000
const toNumber = (s) => Number((s.match(/[\d,.]+/)?.[0] || '').replace(/\.\d{2}$/, '').replace(/[.,]/g, ''));

async function getFares() {
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({ locale: 'vi-VN', viewport: { width: 1366, height: 900 } });
  try {
    await page.goto('https://booking.vietravelairlines.com/vi', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.click('#search-type-oneway');
    // Máy chủ ở nước ngoài có thể mặc định USD -> luôn chọn VND
    await page.selectOption('#criteria-currency-select', { label: 'VND' }).catch(() => {});

    await page.locator('#criteria-departure-single-select-0-input input.vs__search').click();
    await page.locator(`#criteria-departure-single-select-0 #airport-option-${CFG.from}`).click();
    await page.locator('#criteria-destination-single-select-0-input input.vs__search').click();
    await page.locator(`#criteria-destination-single-select-0 #airport-option-${CFG.to}`).click();

    await page.click('#input-cover-button-0');
    const day = page.locator(`button[date="${CFG.date}"]`).first();
    for (let i = 0; i < 12 && !(await day.isVisible()); i++) {
      await page.locator('button[aria-label="next month"]').first().click();
    }
    await day.click();
    await page.click('#criteria-search-button');

    await page.waitForURL(/\/select/, { timeout: 60_000 });
    await page.locator('section.flight').first().waitFor({ timeout: 60_000 });

    const flight = page.locator('section.flight').filter({
      has: page.locator('.times .time').first().filter({ hasText: CFG.time }),
    }).first();
    if (!(await flight.count())) return null;

    const flightNo = (await flight.locator('.flight-number').innerText()).trim();
    // Bấm từng hạng vé -> đọc "Tổng số tiền" (giá vé + thuế, phí) ở khung Tóm tắt đặt chỗ
    const totalEl = page.locator('.booking-total .price');
    const fares = [];
    for (const btn of await flight.locator('button.fare-type').all()) {
      const name = (await btn.locator('.fare-name').first().innerText().catch(() => '')).trim()
        || (await btn.locator('.fare').first().innerText()).trim();
      const amount = await btn.locator('.amount').first().innerText({ timeout: 2_000 }).catch(() => '');
      if (!amount) continue; // hết vé
      const before = await totalEl.innerText({ timeout: 1_000 }).catch(() => '');
      await btn.click();
      await page.waitForFunction(
        (prev) => {
          const t = document.querySelector('.booking-total .price')?.textContent.trim();
          return t && t !== prev.trim();
        },
        before,
        { timeout: 15_000 },
      ).catch(() => {}); // 2 hạng trùng tổng thì text không đổi
      await page.waitForTimeout(500);
      const totalText = await totalEl.innerText();
      if (!/VND/i.test(totalText)) throw new Error(`Tổng số tiền không phải VND: "${totalText.trim()}"`);
      fares.push({
        name: name.replace(/[\s​]+/g, ' ').trim(),
        fare: toNumber(amount),
        price: toNumber(totalText), // tổng số tiền
      });
    }
    return { flightNo, fares };
  } catch (e) {
    const shot = here(`./debug/error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new Error(`${e.message.split('\n')[0]} (ảnh: ${shot})`);
  } finally {
    await browser.close();
  }
}

// Mỗi lần kiểm tra đều gửi báo giá; so sánh với lần trước nhờ state.json
async function checkOnce() {
  const header = `${CFG.from}→${CFG.to} ${CFG.time} ngày 19/11`;
  try {
    const res = await getFares();
    if (!res) {
      log(`Không thấy chuyến ${CFG.time} ngày ${CFG.date}`);
      return notify(`Báo giá ${header}`, 'Không thấy chuyến 07:15 trên trang kết quả.');
    }
    if (!res.fares.length) {
      log(`${res.flightNo} ${CFG.time}: hết vé`);
      return notify(`Báo giá ${header}`, `${res.flightNo}: hết vé.`);
    }

    log(`${res.flightNo} ${CFG.time} (tổng số tiền):`,
      res.fares.map((f) => `${f.name} ${fmt(f.price)}`).join(' | '));
    const cheapest = res.fares.reduce((a, b) => (b.price < a.price ? b : a));
    const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};

    let change = '';
    if (state.lastCheapest) {
      const diff = cheapest.price - state.lastCheapest;
      change = diff < 0 ? ` ▼ giảm ${fmt(-diff)}` : diff > 0 ? ` ▲ tăng ${fmt(diff)}` : ' (không đổi)';
    }
    const hit = cheapest.price <= CFG.maxPrice;
    const lines = [
      `${res.flightNo} · TỔNG SỐ TIỀN (đã gồm thuế, phí) · 1 người lớn:`,
      ...res.fares.map((f) => `• ${f.name}: ${fmt(f.price)}`),
      '',
      `Tổng rẻ nhất: ${fmt(cheapest.price)}${change}`,
      hit ? `✅ ĐÃ ≤ ${fmt(CFG.maxPrice)} — đặt ngay!` : `Mục tiêu: ≤ ${fmt(CFG.maxPrice)}`,
      'https://booking.vietravelairlines.com/vi',
    ];
    await notify(`${hit ? '🔥 ' : ''}Báo giá ${header}`, lines.join('\n'));

    state.lastCheapest = cheapest.price;
    fs.writeFileSync(STATE, JSON.stringify(state));
  } catch (e) {
    log('LỖI:', e.message);
    await notify(`Báo giá ${header}`, `⚠️ Lần kiểm tra này bị lỗi: ${e.message.split(' (ảnh:')[0]}`);
  }
}

if (args.includes('--test-telegram')) {
  await notify('Thử kết nối', 'Bot báo giá vé Vietravel đã hoạt động.');
  process.exit(0);
}

const flightDay = new Date(`${CFG.date}T00:00:00+07:00`);
if (new Date() >= flightDay) {
  console.log('Đã tới ngày bay, ngừng kiểm tra.');
  process.exit(0);
}
while (true) {
  await checkOnce();
  if (ONCE || new Date() >= flightDay) break;
  await new Promise((r) => setTimeout(r, CFG.intervalMin * 60_000));
}
