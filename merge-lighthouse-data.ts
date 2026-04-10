import * as fs from 'fs';
import * as path from 'path';
import { PDFReportGenerator, PDFReportData } from './src/pdfReportGenerator';
import { PageReport, BrokenLink } from './src/types';
import { ViolationDetail } from './src/violationsAggregator';

/**
 * Merge Lighthouse Data and Regenerate Report
 *
 * Takes Lighthouse JSON files from backup-lighthouse-runner.ts and merges them
 * with existing audit data (CSV files) to regenerate the PDF report with
 * updated performance scores.
 *
 * Usage:
 *   npx ts-node merge-lighthouse-data.ts
 *
 * Requirements:
 *   - lighthouse-backups/[domain]/homepage-*.json (from backup-lighthouse-runner.ts)
 *   - results/[domain]/ (existing audit data from main script)
 *
 * Output:
 *   - Updates results/[domain]/site-audit-report.pdf with Lighthouse scores
 */

interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

function loadLighthouseScores(domain: string, viewport: 'desktop' | 'mobile'): LighthouseScores | null {
  const jsonPath = path.join(__dirname, 'lighthouse-backups', domain, `homepage-${viewport}.json`);

  if (!fs.existsSync(jsonPath)) {
    console.log(`  ⚠️  No Lighthouse backup found for ${viewport}: ${jsonPath}`);
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const categories = data.categories;

    return {
      performance: Math.round((categories.performance?.score || 0) * 100),
      accessibility: Math.round((categories.accessibility?.score || 0) * 100),
      bestPractices: Math.round((categories['best-practices']?.score || 0) * 100),
      seo: Math.round((categories.seo?.score || 0) * 100)
    };
  } catch (error: any) {
    console.log(`  ❌ Error reading Lighthouse data: ${error.message}`);
    return null;
  }
}

function parseCSV(filePath: string): any[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) {
    return []; // No data rows
  }

  const headers = lines[0].split(',').map(h => h.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row: any = {};

    headers.forEach((header, idx) => {
      row[header] = values[idx]?.trim() || '';
    });

    rows.push(row);
  }

  return rows;
}

function loadPageReports(domain: string, viewport: 'desktop' | 'mobile', lighthouseScores: LighthouseScores | null): PageReport[] {
  const csvPath = path.join(__dirname, 'results', domain, `page-reports-${viewport}.csv`);
  const rows = parseCSV(csvPath);

  return rows.map(row => {
    const pageReport: PageReport = {
      url: row['URL'] || row['url'] || '',
      viewport: viewport,
      criticalIssues: parseInt(row['Critical Issues'] || row['criticalIssues'] || '0'),
      seriousIssues: parseInt(row['Serious Issues'] || row['seriousIssues'] || '0'),
      moderateIssues: parseInt(row['Moderate Issues'] || row['moderateIssues'] || '0'),
      minorIssues: parseInt(row['Minor Issues'] || row['minorIssues'] || '0'),
      performanceScore: parseInt(row['Performance Score'] || row['performanceScore'] || '0'),
      accessibilityScore: parseInt(row['Accessibility Score'] || row['accessibilityScore'] || '0'),
      bestPracticesScore: parseInt(row['Best Practices Score'] || row['bestPracticesScore'] || '0'),
      seoScore: parseInt(row['SEO Score'] || row['seoScore'] || '0'),
      notes: row['Notes'] || row['notes'] || '',
      auditTier: (row['Audit Tier'] || row['auditTier'] || 'full') as any
    };

    // If this is the homepage and we have Lighthouse scores, update them
    if (lighthouseScores && (pageReport.url.endsWith('/') || pageReport.url.split('/').length <= 3)) {
      console.log(`    Updating homepage scores from Lighthouse backup`);
      pageReport.performanceScore = lighthouseScores.performance;
      pageReport.accessibilityScore = lighthouseScores.accessibility;
      pageReport.bestPracticesScore = lighthouseScores.bestPractices;
      pageReport.seoScore = lighthouseScores.seo;
    }

    return pageReport;
  });
}

function loadViolations(domain: string, viewport: 'desktop' | 'mobile'): ViolationDetail[] {
  const csvPath = path.join(__dirname, 'results', domain, `accessibility-violations-${viewport}.csv`);
  const rows = parseCSV(csvPath);

  // Group by violation type
  const violationMap = new Map<string, ViolationDetail>();

  rows.forEach(row => {
    const violationType = row['Violation Type'] || row['violationType'] || 'Unknown';

    if (!violationMap.has(violationType)) {
      violationMap.set(violationType, {
        violationType: violationType,
        severity: (row['Severity'] || row['severity'] || 'minor') as any,
        description: row['Description'] || row['description'] || '',
        totalInstances: 0,
        pageUrls: [],
        elements: []
      });
    }

    const violation = violationMap.get(violationType)!;
    violation.totalInstances++;

    const pageUrl = row['Page URL'] || row['pageUrl'] || '';
    if (!violation.pageUrls.includes(pageUrl)) {
      violation.pageUrls.push(pageUrl);
    }

    const html = row['Example HTML'] || row['exampleHtml'] || '';
    if (html && violation.elements.length < 5) {
      violation.elements.push(html);
    }
  });

  return Array.from(violationMap.values());
}

function loadBrokenLinks(domain: string, viewport: 'desktop' | 'mobile'): BrokenLink[] {
  const csvPath = path.join(__dirname, 'results', domain, `broken-links-${viewport}.csv`);
  const rows = parseCSV(csvPath);

  return rows.map(row => ({
    pageUrl: row['Page URL'] || row['pageUrl'] || '',
    linkUrl: row['Link URL'] || row['linkUrl'] || '',
    linkType: (row['Link Type'] || row['linkType'] || 'url') as any,
    linkText: row['Link Text'] || row['linkText'] || '',
    statusCode: parseInt(row['Status Code'] || row['statusCode'] || '0') || undefined,
    errorMessage: row['Error Message'] || row['errorMessage'] || '',
    viewport: viewport
  }));
}

// Normalize domain name by removing dots and special chars (matches main audit behavior)
function normalizeDomainForResults(domain: string): string {
  return domain.replace(/[^a-z0-9]/gi, '');
}

async function mergeLighthouseData(lighthouseDomain: string) {
  console.log(`\n[$] Merging data for: ${lighthouseDomain}`);
  console.log('='.repeat(60));

  // Try to find matching results directory
  // The results directory uses sanitized names (no dots/dashes)
  const normalizedDomain = normalizeDomainForResults(lighthouseDomain);
  const resultsDir = path.join(__dirname, 'results', normalizedDomain);

  if (!fs.existsSync(resultsDir)) {
    console.log(`  ❌ No existing results found for ${lighthouseDomain}`);
    console.log(`     Tried: ${resultsDir}`);
    console.log(`     (normalized from ${lighthouseDomain} to ${normalizedDomain})`);
    return false;
  }

  console.log(`  ✓ Found results directory: ${normalizedDomain}`);
  const domain = normalizedDomain;

  // Load Lighthouse scores (using original lighthouse domain name with dots)
  console.log('  Loading Lighthouse backup data...');
  const desktopScores = loadLighthouseScores(lighthouseDomain, 'desktop');
  const mobileScores = loadLighthouseScores(lighthouseDomain, 'mobile');

  if (!desktopScores && !mobileScores) {
    console.log(`  ❌ No Lighthouse backup data found for ${lighthouseDomain}`);
    return false;
  }

  // Load existing audit data
  console.log('  Loading existing audit data...');
  const desktopReports = loadPageReports(domain, 'desktop', desktopScores);
  const mobileReports = loadPageReports(domain, 'mobile', mobileScores);

  const desktopViolations = loadViolations(domain, 'desktop');
  const mobileViolations = loadViolations(domain, 'mobile');

  const desktopLinks = loadBrokenLinks(domain, 'desktop');
  const mobileLinks = loadBrokenLinks(domain, 'mobile');

  console.log(`    Desktop: ${desktopReports.length} pages, ${desktopViolations.length} violation types, ${desktopLinks.length} broken links`);
  console.log(`    Mobile: ${mobileReports.length} pages, ${mobileViolations.length} violation types, ${mobileLinks.length} broken links`);

  // Create PDF data structure
  const pdfData: PDFReportData = {
    domain: domain,
    desktop: {
      pageReports: desktopReports,
      violations: desktopViolations,
      brokenLinks: desktopLinks
    },
    mobile: {
      pageReports: mobileReports,
      violations: mobileViolations,
      brokenLinks: mobileLinks
    }
  };

  // Generate PDF
  console.log('  Regenerating PDF report...');
  const pdfGenerator = new PDFReportGenerator(resultsDir);
  await pdfGenerator.generateReport(pdfData);

  console.log(`  ✅ PDF updated: ${path.join(resultsDir, 'site-audit-report.pdf')}`);
  return true;
}

async function main() {
  console.log('🔄 Merge Lighthouse Data and Regenerate Reports\n');
  console.log('='.repeat(60));

  // Find all domains with Lighthouse backup data
  const backupDir = path.join(__dirname, 'lighthouse-backups');

  if (!fs.existsSync(backupDir)) {
    console.error('❌ No lighthouse-backups directory found!');
    console.error('   Run backup-lighthouse-runner.ts first.');
    process.exit(1);
  }

  const domains = fs.readdirSync(backupDir).filter(file => {
    const stat = fs.statSync(path.join(backupDir, file));
    return stat.isDirectory();
  });

  if (domains.length === 0) {
    console.error('❌ No domains found in lighthouse-backups/');
    process.exit(1);
  }

  console.log(`Found ${domains.length} domain(s) with Lighthouse backup data:\n`);
  domains.forEach((domain, i) => console.log(`  ${i + 1}. ${domain}`));
  console.log('');

  // Process each domain
  let successCount = 0;
  for (const domain of domains) {
    const success = await mergeLighthouseData(domain);
    if (success) {
      successCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✅ Complete! Updated ${successCount}/${domains.length} report(s)`);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
