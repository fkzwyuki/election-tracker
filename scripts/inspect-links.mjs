#!/usr/bin/env node
const urls = process.argv.slice(2);
for (const url of urls) {
  console.log('\n=== ' + url + ' ===');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    console.log('Status:', res.status, 'Final:', res.url);
    const html = await res.text();
    const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    let count = 0;
    while ((m = re.exec(html)) !== null) {
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (/開票|速報|結果|市議|選挙|令和8|2026|pdf/i.test(text) || /pdf|senkyo|kaihyo|sokuho/i.test(m[1])) {
        try {
          console.log(' -', text || '(no text)', '=>', new URL(m[1], res.url).toString());
          if (++count >= 25) break;
        } catch {}
      }
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}
