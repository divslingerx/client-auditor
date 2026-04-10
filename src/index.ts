import * as fs from 'fs';
import * as path from 'path';
import { SiteAuditor } from './siteAuditor';
import { AuditStrategy } from './types';
import { PDFReportGenerator, PDFReportData } from './pdfReportGenerator';

// Global error handlers to prevent crashes from unhandled errors
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Promise Rejection:', reason);
  // Don't exit - try to continue
});

process.on('uncaughtException', (error) => {
  console.error('⚠️  Uncaught Exception:', error);
  // For uncaught exceptions, we should exit after logging
  process.exit(1);
});

async function readSitesFile(): Promise<string[]> {
  const sitesPath = path.join(__dirname, 'sites.txt');
  console.log(`Reading sites from: ${sitesPath}`);
  
  if (!fs.existsSync(sitesPath)) {
    console.error(`Sites file not found at: ${sitesPath}`);
    return [];
  }
  
  const content = fs.readFileSync(sitesPath, 'utf-8');
  const sites = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  
  console.log(`Parsed ${sites.length} sites from file`);
  return sites;
}

function parseAuditStrategy(): AuditStrategy {
  const args = process.argv.slice(2);
  const strategy: AuditStrategy = {
    mode: 'fast', // Default to fast mode
    samplesPerPattern: 3,
    useSitemap: true,
    viewports: 'both',
    lighthouseSamples: -2, // Template-aware: all top-level pages + 1 per sub-route pattern
    concurrency: 3
  };

  args.forEach(arg => {
    if (arg.startsWith('--mode=')) {
      const mode = arg.split('=')[1];
      if (mode === 'comprehensive' || mode === 'fast') {
        strategy.mode = mode;
        // Comprehensive mode runs Lighthouse on all pages by default
        if (mode === 'comprehensive') {
          strategy.lighthouseSamples = -1;
        }
      }
    } else if (arg.startsWith('--samples=')) {
      const samples = parseInt(arg.split('=')[1], 10);
      if (!isNaN(samples) && samples > 0) {
        strategy.samplesPerPattern = samples;
      }
    } else if (arg.startsWith('--lighthouse-samples=')) {
      const samples = parseInt(arg.split('=')[1], 10);
      if (!isNaN(samples)) {
        strategy.lighthouseSamples = samples;
      }
    } else if (arg.startsWith('--viewport=')) {
      const viewport = arg.split('=')[1];
      if (viewport === 'desktop' || viewport === 'mobile' || viewport === 'both') {
        strategy.viewports = viewport;
      }
    } else if (arg === '--desktop-only') {
      strategy.viewports = 'desktop';
    } else if (arg === '--mobile-only') {
      strategy.viewports = 'mobile';
    } else if (arg === '--no-sitemap') {
      strategy.useSitemap = false;
    } else if (arg.startsWith('--concurrency=')) {
      const concurrency = parseInt(arg.split('=')[1], 10);
      if (!isNaN(concurrency) && concurrency >= 1) {
        strategy.concurrency = concurrency;
      }
    }
  });

  return strategy;
}

async function rebuildReports(): Promise<void> {
  const resultsBase = path.join(process.cwd(), 'results');
  if (!fs.existsSync(resultsBase)) {
    console.error('No results directory found.');
    return;
  }

  const dirs = fs.readdirSync(resultsBase).filter(d =>
    fs.statSync(path.join(resultsBase, d)).isDirectory()
  );

  if (dirs.length === 0) {
    console.error('No audit result directories found in results/.');
    return;
  }

  for (const dir of dirs) {
    const resultDir = path.join(resultsBase, dir);
    const dataPath = path.join(resultDir, 'report-data.json');

    if (!fs.existsSync(dataPath)) {
      console.log(`Skipping ${dir}/ — no report-data.json (run a full audit first)`);
      continue;
    }

    console.log(`Rebuilding report for ${dir}...`);
    const pdfData: PDFReportData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const pdfGenerator = new PDFReportGenerator(resultDir, pdfData.domain);
    await pdfGenerator.generateReport(pdfData);
    console.log(`  Done.\n`);
  }

  console.log('All reports rebuilt.');
}

async function main() {
  // Handle --rebuild-report before anything else
  if (process.argv.includes('--rebuild-report')) {
    console.log('Rebuilding reports from saved audit data...\n');
    await rebuildReports();
    return;
  }

  console.log('🚀 Client Auditor Starting...\n');

  try {
    // Parse CLI flags
    const clearProgress = process.argv.includes('--clear-progress');
    const auditStrategy = parseAuditStrategy();

    if (clearProgress) {
      console.log('📝 Starting fresh audit (clearing any previous progress)\n');
    }

    const sites = await readSitesFile();

    if (sites.length === 0) {
      console.log('No sites found in sites.txt');
      return;
    }

    console.log(`Found ${sites.length} site(s) to audit:\n`);
    sites.forEach(site => console.log(`  - ${site}`));
    console.log('');

    for (const siteUrl of sites) {
      const auditor = new SiteAuditor(siteUrl, clearProgress, auditStrategy);
      await auditor.audit();
      console.log('\n' + '='.repeat(60) + '\n');

      // Force garbage collection between sites (if available)
      if (global.gc) {
        console.log('Running garbage collection...');
        global.gc();
      }

      // Small delay to allow memory cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('✅ All audits complete!');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  console.log('Starting application...');
  main()
    .then(() => {
      console.log('Application finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Application error:', error);
      process.exit(1);
    });
}

export { SiteAuditor };