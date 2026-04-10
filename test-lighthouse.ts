import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import lighthouse from 'lighthouse';

puppeteer.use(StealthPlugin());

async function testLighthouse() {
  console.log('🚀 Starting Lighthouse test...\n');

  let browser;
  let page;

  try {
    // Launch browser
    console.log('1. Launching browser...');
    browser = await puppeteer.launch({
      headless: 'new' as any,
      defaultViewport: { width: 1920, height: 1080 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ]
    });
    console.log('   ✅ Browser launched\n');

    // Extract port
    const wsEndpoint = browser.wsEndpoint();
    console.log('2. Browser WebSocket endpoint:', wsEndpoint);
    const port = new URL(wsEndpoint).port;
    console.log('   Port extracted:', port);
    console.log('   ✅ Port extracted\n');

    // Create page
    console.log('3. Creating page...');
    page = await browser.newPage();
    console.log('   ✅ Page created\n');

    // Navigate to a test URL
    const testUrl = 'https://example.com';
    console.log(`4. Navigating to ${testUrl}...`);
    await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('   ✅ Navigation successful\n');

    // Test 1: Lighthouse with page (our current approach)
    console.log('5. Running Lighthouse WITH page parameter...');
    try {
      const result1 = await lighthouse(testUrl, {
        port: parseInt(port, 10),
        maxWaitForLoad: 30000,
        onlyCategories: ['performance', 'accessibility'],
        throttlingMethod: 'devtools',
        formFactor: 'desktop',
        disableStorageReset: true,
        skipAudits: ['screenshot-thumbnails', 'final-screenshot'],
      }, undefined, page);

      if (result1?.lhr) {
        console.log('   ✅ SUCCESS with page!');
        console.log('   Performance:', (result1.lhr.categories.performance.score || 0) * 100);
        console.log('   Accessibility:', (result1.lhr.categories.accessibility.score || 0) * 100);
      } else {
        console.log('   ❌ No results returned (but no error thrown)');
      }
    } catch (error: any) {
      console.log('   ❌ ERROR with page:', error.message);
      console.log('   Stack:', error.stack?.slice(0, 500));
    }
    console.log('');

    // Test 2: Lighthouse without page (traditional approach)
    console.log('6. Running Lighthouse WITHOUT page parameter...');
    try {
      const result2 = await lighthouse(testUrl, {
        port: parseInt(port, 10),
        maxWaitForLoad: 30000,
        onlyCategories: ['performance', 'accessibility'],
        throttlingMethod: 'devtools',
        formFactor: 'desktop',
        disableStorageReset: true,
        skipAudits: ['screenshot-thumbnails', 'final-screenshot'],
      });

      if (result2?.lhr) {
        console.log('   ✅ SUCCESS without page!');
        console.log('   Performance:', (result2.lhr.categories.performance.score || 0) * 100);
        console.log('   Accessibility:', (result2.lhr.categories.accessibility.score || 0) * 100);
      } else {
        console.log('   ❌ No results returned (but no error thrown)');
      }
    } catch (error: any) {
      console.log('   ❌ ERROR without page:', error.message);
      console.log('   Stack:', error.stack?.slice(0, 500));
    }
    console.log('');

    // Test 3: Lighthouse without port (new browser)
    console.log('7. Running Lighthouse without port (launches own browser)...');
    try {
      const result3 = await lighthouse(testUrl, {
        maxWaitForLoad: 30000,
        onlyCategories: ['performance'],
        throttlingMethod: 'provided',
        formFactor: 'desktop',
        skipAudits: ['screenshot-thumbnails', 'final-screenshot'],
      });

      if (result3?.lhr) {
        console.log('   ✅ SUCCESS without port!');
        console.log('   Performance:', (result3.lhr.categories.performance.score || 0) * 100);
      } else {
        console.log('   ❌ No results returned (but no error thrown)');
      }
    } catch (error: any) {
      console.log('   ❌ ERROR without port:', error.message);
      console.log('   Stack:', error.stack?.slice(0, 500));
    }

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    console.log('\n🏁 Test complete');
  }
}

testLighthouse();
