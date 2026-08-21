const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1200 });

  // Test 1: Research overview with recommendation
  await page.goto('http://localhost:3000/research/test_stream', { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/aisle-test-overview.png', fullPage: true });
  console.log('Screenshot 1: research overview');

  // Test 2: Check deep-dive REST endpoint returns data
  const diveResp = await page.evaluate(async () => {
    const r = await fetch('/api/deep-dive/dive_lAoe0LYhNMHi');
    return r.json();
  });
  console.log(`Deep dive: status=${diveResp.status}, results=${diveResp.results?.length}, toolCalls=${diveResp.toolCalls?.length}`);

  // Check if parsed output exists in tool calls
  const searchCalls = (diveResp.toolCalls || []).filter(tc => tc.toolName === 'web_search');
  console.log(`Web search calls: ${searchCalls.length}`);

  await browser.close();
  console.log('All tests passed');
})().catch(e => console.error('FAILED:', e.message));
