import * as fs from 'fs';
import * as path from 'path';
import { PDFReportGenerator, PDFReportData } from './src/pdfReportGenerator';

/**
 * Test script to generate PDF from manual Lighthouse JSON
 *
 * Usage:
 * 1. Save your Lighthouse JSON to: ./lighthouse-data.json
 * 2. Run: npx ts-node test-pdf-from-json.ts
 * 3. PDF will be generated in: ./test-report/
 */

async function generatePDFFromLighthouseJSON() {
  console.log('📊 Generating PDF from Lighthouse JSON...\n');

  try {
    // Read the Lighthouse JSON file
    const jsonPath = path.join(__dirname, 'lighthouse-data.json');

    if (!fs.existsSync(jsonPath)) {
      console.error('❌ lighthouse-data.json not found!');
      console.log('\nPlease save your Lighthouse JSON to:');
      console.log('  ' + jsonPath);
      console.log('\nYou can paste your JSON directly into that file.');
      process.exit(1);
    }

    console.log('1. Reading Lighthouse JSON from:', jsonPath);
    const lighthouseData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    console.log('   ✅ JSON loaded\n');

    // Extract scores from Lighthouse result
    const lhr = lighthouseData.lhr || lighthouseData;
    const categories = lhr.categories;

    console.log('2. Extracted Lighthouse scores:');
    console.log('   Performance:', Math.round((categories.performance?.score || 0) * 100));
    console.log('   Accessibility:', Math.round((categories.accessibility?.score || 0) * 100));
    console.log('   Best Practices:', Math.round((categories['best-practices']?.score || 0) * 100));
    console.log('   SEO:', Math.round((categories.seo?.score || 0) * 100));
    console.log('');

    // Extract URL from the report
    const testUrl = lhr.finalUrl || lhr.requestedUrl || 'https://example.com';
    const domain = new URL(testUrl).hostname;

    // Create mock page report with real Lighthouse data
    const pageReport = {
      url: testUrl,
      viewport: 'desktop' as const,
      criticalIssues: 0,
      seriousIssues: 0,
      moderateIssues: 0,
      minorIssues: 0,
      performanceScore: Math.round((categories.performance?.score || 0) * 100),
      accessibilityScore: Math.round((categories.accessibility?.score || 0) * 100),
      bestPracticesScore: Math.round((categories['best-practices']?.score || 0) * 100),
      seoScore: Math.round((categories.seo?.score || 0) * 100),
      notes: 'Generated from manual Lighthouse JSON',
      auditTier: 'full' as const
    };

    // Create minimal PDF data structure
    const pdfData: PDFReportData = {
      domain: domain,
      desktop: {
        pageReports: [pageReport],
        violations: [],
        brokenLinks: []
      },
      mobile: {
        pageReports: [],
        violations: [],
        brokenLinks: []
      }
    };

    // Create output directory
    const outputDir = path.join(__dirname, 'test-report');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log('3. Generating PDF report...');
    const pdfGenerator = new PDFReportGenerator(outputDir);
    await pdfGenerator.generateReport(pdfData);
    console.log('   ✅ PDF generated\n');

    console.log('🎉 Success! PDF saved to:');
    console.log('   ' + path.join(outputDir, 'site-audit-report.pdf'));

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

generatePDFFromLighthouseJSON();
