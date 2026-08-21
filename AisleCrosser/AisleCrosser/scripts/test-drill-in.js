const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });

  // Load research page
  await page.goto('http://localhost:3000/research/test_stream', { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // Screenshot 1: Overview with candidate card
  await page.screenshot({ path: '/tmp/aisle-drill-1-overview.png', fullPage: true });
  console.log('Screenshot 1: overview with candidate card');

  // Click the candidate card to drill in
  // Find the clickable card with "Sen. Dan Sullivan"
  const clicked = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="cursor-pointer"]');
    for (const card of cards) {
      if (card.textContent.includes('Sen. Dan Sullivan') || card.textContent.includes('Sullivan')) {
        card.click();
        return true;
      }
    }
    return false;
  });
  console.log('Clicked candidate card:', clicked);

  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: '/tmp/aisle-drill-2-candidate.png', fullPage: true });
  console.log('Screenshot 2: candidate detail view with connections');

  // Now look for a "Deep dive" or connection badge to click
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 5000));
  console.log('Page text (first 500):', pageText.slice(0, 500));

  await browser.close();
  console.log('Drill-in test complete');
})().catch(e => console.error('FAILED:', e.message));
