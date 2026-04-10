import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import lighthouse from 'lighthouse';
import * as fs from 'fs';
import * as path from 'path';

puppeteer.use(StealthPlugin());

/**
 * Backup Lighthouse Runner
 *
 * Runs Lighthouse audits independently when the main script fails.
 * Reads from sites.txt and saves Lighthouse JSON for each site.
 *
 * Usage:
 *   npx ts-node backup-lighthouse-runner.ts
 *
 * Output:
 *   lighthouse-backups/[domain]/
 *     - homepage-desktop.json
 *     - homepage-mobile.json
 */

interface LighthouseBackupConfig {
  runDesktop: boolean;
  runMobile: boolean;
}

async function runLighthouseBackup(url: string, viewport: 'desktop' | 'mobile', outputDir: string) {
  let browser;

  try {
    const viewportConfig = viewport === 'desktop'
      ? { width: 1920, height: 1080 }
      : { width: 393, height: 852 };

    console.log(`  Launching ${viewport} browser...`);
    browser = await puppeteer.launch({
      headless: 'new' as any,
      defaultViewport: viewportConfig,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ]
    });

    const wsEndpoint = browser.wsEndpoint();
    const port = new URL(wsEndpoint).port;
    console.log(`  Browser launched on port ${port}`);

    const page = await browser.newPage();

    if (viewport === 'mobile') {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1');
    }

    console.log(`  Navigating to ${url}...`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 45000
    }).catch(async () => {
      // Fallback to domcontentloaded
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
    });

    console.log(`  Running Lighthouse audit...`);
    const result = await lighthouse(url, {
      port: parseInt(port, 10),
      maxWaitForLoad: 60000,
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      throttlingMethod: 'devtools',
      formFactor: viewport === 'mobile' ? 'mobile' : 'desktop',
      screenEmulation: {
        mobile: viewport === 'mobile',
        width: viewport === 'mobile' ? 393 : 1920,
        height: viewport === 'mobile' ? 852 : 1080,
        deviceScaleFactor: viewport === 'mobile' ? 2 : 1,
        disabled: false
      },
      emulatedUserAgent: viewport === 'mobile'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15'
        : undefined,
      disableStorageReset: true,
      skipAudits: [
        'screenshot-thumbnails',
        'final-screenshot',
        'full-page-screenshot',
        'script-treemap-data',
      ],
    }, undefined, page);

    if (result?.lhr) {
      const outputFile = path.join(outputDir, `homepage-${viewport}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(result.lhr, null, 2));

      console.log(`  ✅ Success! Scores:`);
      console.log(`     Performance: ${Math.round((result.lhr.categories.performance.score || 0) * 100)}`);
      console.log(`     Accessibility: ${Math.round((result.lhr.categories.accessibility.score || 0) * 100)}`);
      console.log(`     Best Practices: ${Math.round((result.lhr.categories['best-practices'].score || 0) * 100)}`);
      console.log(`     SEO: ${Math.round((result.lhr.categories.seo.score || 0) * 100)}`);
      console.log(`     Saved to: ${outputFile}`);

      return true;
    } else {
      console.log(`  ❌ Lighthouse returned no results`);
      return false;
    }

  } catch (error: any) {
    console.log(`  ❌ Error: ${error.message}`);
    return false;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function main() {
  console.log('🚀 Backup Lighthouse Runner\n');
  console.log('='.repeat(60));

  // Read sites.txt
  const sitesPath = path.join(__dirname, 'src', 'sites.txt');
  if (!fs.existsSync(sitesPath)) {
    console.error('❌ sites.txt not found at:', sitesPath);
    process.exit(1);
  }

  const sitesContent = fs.readFileSync(sitesPath, 'utf-8');
  const sites = sitesContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  if (sites.length === 0) {
    console.error('❌ No sites found in sites.txt');
    process.exit(1);
  }

  console.log(`Found ${sites.length} site(s) in sites.txt:\n`);
  sites.forEach((site, i) => console.log(`  ${i + 1}. ${site}`));
  console.log('');

  // Config: run both desktop and mobile by default
  const config: LighthouseBackupConfig = {
    runDesktop: true,
    runMobile: true
  };

  // Create output directory
  const backupDir = path.join(__dirname, 'lighthouse-backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Process each site
  for (let i = 0; i < sites.length; i++) {
    const siteUrl = sites[i];
    const domain = new URL(siteUrl).hostname;

    console.log(`\n[$${i + 1}/${sites.length}] Processing: ${domain}`);
    console.log('='.repeat(60));

    // Create domain-specific output directory
    const domainDir = path.join(backupDir, domain);
    if (!fs.existsSync(domainDir)) {
      fs.mkdirSync(domainDir, { recursive: true });
    }

    // Run desktop audit
    if (config.runDesktop) {
      console.log('\n📊 Desktop Audit:');
      await runLighthouseBackup(siteUrl, 'desktop', domainDir);
    }

    // Run mobile audit
    if (config.runMobile) {
      console.log('\n📱 Mobile Audit:');
      await runLighthouseBackup(siteUrl, 'mobile', domainDir);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Backup Lighthouse run complete!');
  console.log(`\nResults saved to: ${backupDir}`);
  console.log('\nNext step: Run merge-lighthouse-data.ts to update your reports');
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
