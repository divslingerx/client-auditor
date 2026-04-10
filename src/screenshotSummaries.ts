/**
 * Screenshot Summary Slides
 *
 * Opens each site's HTML report in headless Chrome, navigates to the slide
 * summary page (.ss-page), clips out the dark header bar (.ss-header), and
 * saves a PNG to summary-images/{domain}-summary.png.
 *
 * Usage: pnpm screenshot-summaries
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

puppeteer.use(StealthPlugin());

async function screenshotSummaries(): Promise<void> {
  const resultsBase = path.join(process.cwd(), 'results');
  const outputDir = path.join(process.cwd(), 'summary-images');

  if (!fs.existsSync(resultsBase)) {
    console.error('No results directory found.');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // Find all *-report.html files across result subdirectories
  const htmlReports: { htmlPath: string; domain: string; safeDomain: string }[] = [];

  const dirs = fs.readdirSync(resultsBase).filter(d =>
    fs.statSync(path.join(resultsBase, d)).isDirectory()
  );

  for (const dir of dirs) {
    const dirPath = path.join(resultsBase, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('-report.html'));
    for (const file of files) {
      const safeDomain = file.replace('-report.html', '');
      htmlReports.push({
        htmlPath: path.join(dirPath, file),
        domain: dir,
        safeDomain
      });
    }
  }

  if (htmlReports.length === 0) {
    console.log('No *-report.html files found in results/. Run pnpm rebuild-report first.');
    return;
  }

  console.log(`Found ${htmlReports.length} report(s). Launching browser...\n`);

  const browser = await puppeteer.launch({
    headless: 'new' as any,
    defaultViewport: { width: 1200, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    for (const { htmlPath, domain, safeDomain } of htmlReports) {
      const outputPath = path.join(outputDir, `${safeDomain}-summary.png`);
      console.log(`Processing: ${domain}`);

      const page = await browser.newPage();
      try {
        // Use file:// URL — Puppeteer handles this fine
        const fileUrl = `file://${htmlPath}`;
        await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

        // Wait for Chart.js canvases to render
        await page.waitForFunction(() => {
          const canvases = document.querySelectorAll('.ss-page canvas');
          return canvases.length > 0;
        }, { timeout: 10000 }).catch(() => {
          // Canvas may not exist if no lighthouse data — continue anyway
        });

        // Small extra delay to ensure chart animation completes
        await new Promise(resolve => setTimeout(resolve, 800));

        // Remove the A4 min-height so the page shrinks to its content
        await page.addStyleTag({ content: '.ss-page { min-height: 0 !important; height: auto !important; }' });

        // Get bounding boxes for the summary page and its header
        const rects = await page.evaluate(() => {
          const ssPage = document.querySelector('.ss-page');
          const ssHeader = document.querySelector('.ss-header');
          const ssFooter = document.querySelector('.ss-footer');
          if (!ssPage) return null;
          const pageRect = ssPage.getBoundingClientRect();
          const headerRect = ssHeader ? ssHeader.getBoundingClientRect() : null;
          const footerRect = ssFooter ? ssFooter.getBoundingClientRect() : null;
          return {
            page: { x: pageRect.x, y: pageRect.y, width: pageRect.width },
            header: headerRect ? { height: headerRect.height } : null,
            // Bottom of footer relative to page top, or fall back to full page height
            contentBottom: footerRect
              ? footerRect.bottom - pageRect.y
              : pageRect.height
          };
        });

        if (!rects) {
          console.log(`  ⚠️  No .ss-page found in ${domain} report — skipping`);
          continue;
        }

        // Scroll the summary page into view before screenshotting
        await page.evaluate(() => {
          document.querySelector('.ss-page')?.scrollIntoView();
        });

        const headerHeight = rects.header?.height ?? 0;
        const clip = {
          x: Math.round(rects.page.x),
          y: Math.round(rects.page.y + headerHeight),
          width: Math.round(rects.page.width),
          height: Math.round(rects.contentBottom - headerHeight)
        };

        await page.screenshot({
          path: outputPath as `${string}.png`,
          clip
        });

        console.log(`  ✓ Saved: ${path.basename(outputPath)}`);
      } catch (err: any) {
        console.error(`  ✗ Failed for ${domain}: ${err.message?.slice(0, 100)}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone. Screenshots saved to: ${outputDir}`);
}

screenshotSummaries().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
