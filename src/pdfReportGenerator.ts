import * as fs from "fs";
import * as path from "path";
import puppeteer from "puppeteer-extra";
import { ViolationDetail } from "./violationsAggregator";
import { PageReport, BrokenLink, FailedPageEntry } from "./types";

export interface PDFReportData {
  domain: string;
  desktop: {
    pageReports: PageReport[];
    violations: ViolationDetail[];
    brokenLinks: BrokenLink[];
  };
  mobile: {
    pageReports: PageReport[];
    violations: ViolationDetail[];
    brokenLinks: BrokenLink[];
  };
  failedPages?: FailedPageEntry[];
}

export class PDFReportGenerator {
  private outputPath: string;
  private htmlOutputPath: string;

  constructor(outputDir: string, domain?: string) {
    const safeDomain = (domain || "site").replace(/[<>:"/\\|?*]/g, "-");
    this.outputPath = path.join(outputDir, `${safeDomain}-report.pdf`);
    this.htmlOutputPath = path.join(outputDir, `${safeDomain}-report.html`);
  }

  async generateReport(data: PDFReportData): Promise<void> {
    const html = this.buildHtml(data);

    // Write HTML report alongside PDF
    fs.writeFileSync(this.htmlOutputPath, html);

    // Use Puppeteer to convert HTML to PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      // Wait for Chart.js to render all canvases
      await page
        .waitForFunction(
          () => {
            const canvases = document.querySelectorAll("canvas");
            return (
              canvases.length === 0 ||
              Array.from(canvases).every((c) => c.getContext("2d") !== null)
            );
          },
          { timeout: 10000 }
        )
        .catch(() => {});

      // Small delay for chart animations to complete
      await new Promise((r) => setTimeout(r, 1500));

      await page.pdf({
        path: this.outputPath,
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });

      console.log(`  PDF report saved to: ${this.outputPath}`);
      console.log(`  HTML report saved to: ${this.htmlOutputPath}`);
    } finally {
      await browser.close();
    }
  }

  private buildHtml(data: PDFReportData): string {
    const hasDesktop = data.desktop.pageReports.length > 0;
    const hasMobile = data.mobile.pageReports.length > 0;

    // Calculate stats
    const stats = this.calculateStats(data);

    const sc = (n: number) => n >= 90 ? '#10B981' : n >= 50 ? '#F59E0B' : '#EF4444';
    const coloredDetail = (d: number, m: number) =>
      hasDesktop && hasMobile
        ? `<span style="color:${sc(d)}">Desktop: ${d}%</span> | <span style="color:${sc(m)}">Mobile: ${m}%</span>`
        : hasDesktop ? `<span style="color:${sc(d)}">${d}%</span>`
        : `<span style="color:${sc(m)}">${m}%</span>`;

    // Read Chart.js from node_modules
    const chartJsPath = path.join(
      __dirname,
      "..",
      "node_modules",
      "chart.js",
      "dist",
      "chart.umd.js"
    );
    let chartJsScript = "";
    try {
      chartJsScript = fs.readFileSync(chartJsPath, "utf-8");
    } catch {
      // Fallback: try alternative path
      try {
        const altPath = path.join(
          process.cwd(),
          "node_modules",
          "chart.js",
          "dist",
          "chart.umd.js"
        );
        chartJsScript = fs.readFileSync(altPath, "utf-8");
      } catch {
        console.log("  Warning: Chart.js not found, charts will be skipped");
      }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Site Audit Report - ${this.escapeHtml(data.domain)}</title>
<style>
${this.getCss()}
</style>
</head>
<body>

<!-- Page 1: Cover -->
<div class="page cover-page">
  <div class="cover-header">
    <div class="cover-badge">SITE AUDIT REPORT</div>
    <h1 class="cover-domain">${this.escapeHtml(data.domain)}</h1>
    <p class="cover-date">${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
  </div>
  <div class="cover-stats">
    <div class="stat-card">
      <div class="stat-number">${stats.totalPages}</div>
      <div class="stat-label">Pages Audited</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${stats.fullAudits}</div>
      <div class="stat-label">Full Audits</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${stats.totalCritical}</div>
      <div class="stat-label">Critical Issues</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${stats.totalBrokenLinks}</div>
      <div class="stat-label">Broken Links</div>
    </div>
  </div>
  <div class="cover-viewports">
    ${hasDesktop && hasMobile ? "Desktop &amp; Mobile" : hasDesktop ? "Desktop Only" : "Mobile Only"}
  </div>
  <div class="cover-footer">Generated by TMC</div>
</div>

<!-- Page 2: Slide Summary -->
${this.buildSlideSummaryPage(data, stats)}

<!-- Page 3: Score Dashboard -->
<div class="page">
  <div class="page-header">
    <h2>Score Dashboard</h2>
    <p class="page-subtitle">Average scores from Lighthouse audits across ${stats.fullAudits} page${stats.fullAudits !== 1 ? "s" : ""}</p>
  </div>
  <div class="score-gauges">
    <div class="gauge-container">
      <canvas id="gaugePerf" width="160" height="160"></canvas>
      <div class="gauge-label">Performance</div>
      ${this.scoreLabel(stats.avgPerf)}
      <div class="gauge-detail">${coloredDetail(stats.desktopPerf, stats.mobilePerf)}</div>
    </div>
    <div class="gauge-container">
      <canvas id="gaugeA11y" width="160" height="160"></canvas>
      <div class="gauge-label">Accessibility</div>
      ${this.scoreLabel(stats.avgA11y)}
      <div class="gauge-detail">${coloredDetail(stats.desktopA11y, stats.mobileA11y)}</div>
    </div>
    <div class="gauge-container">
      <canvas id="gaugeSeo" width="160" height="160"></canvas>
      <div class="gauge-label">SEO</div>
      ${this.scoreLabel(stats.avgSeo)}
      <div class="gauge-detail">${coloredDetail(stats.desktopSeo, stats.mobileSeo)}</div>
    </div>
    <div class="gauge-container">
      <canvas id="gaugeBp" width="160" height="160"></canvas>
      <div class="gauge-label">Best Practices</div>
      ${this.scoreLabel(stats.avgBp)}
      <div class="gauge-detail">${coloredDetail(stats.desktopBp, stats.mobileBp)}</div>
    </div>
  </div>

  <!-- Issues at a Glance -->
  ${this.buildIssuesAtAGlance(data, stats)}

  ${
    hasDesktop && hasMobile
      ? `
  <div class="section-spacing"></div>
  <h3 class="section-title">Desktop vs Mobile Comparison</h3>
  <div class="chart-container radar-container">
    <canvas id="radarChart" width="450" height="300"></canvas>
  </div>
  `
      : ""
  }
</div>

<!-- Page 3: Audit Coverage & Severity -->
<div class="page">
  <div class="page-header">
    <h2>Audit Overview</h2>
  </div>
  <div class="two-col">
    <div class="col">
      <h3 class="section-title">Audit Coverage</h3>
      <div class="chart-container-sm">
        <canvas id="coverageChart" width="340" height="340"></canvas>
      </div>
      <div class="coverage-legend">
        <div class="legend-item"><span class="legend-dot" style="background:#3B82F6"></span> Full Audit (Lighthouse + Axe): ${stats.fullAudits}</div>
        <div class="legend-item"><span class="legend-dot" style="background:#93C5FD"></span> Accessibility Only (Axe): ${stats.axeOnlyAudits}</div>
      </div>
    </div>
    <div class="col">
      <h3 class="section-title">Issue Severity Distribution</h3>
      <div class="chart-container-sm">
        <canvas id="severityChart" width="340" height="340"></canvas>
      </div>
      <div class="coverage-legend">
        <div class="legend-item"><span class="legend-dot" style="background:#DC2626"></span> Critical: ${stats.severityCounts.critical}</div>
        <div class="legend-item"><span class="legend-dot" style="background:#F59E0B"></span> Serious: ${stats.severityCounts.serious}</div>
        <div class="legend-item"><span class="legend-dot" style="background:#3B82F6"></span> Moderate: ${stats.severityCounts.moderate}</div>
        <div class="legend-item"><span class="legend-dot" style="background:#9CA3AF"></span> Minor: ${stats.severityCounts.minor}</div>
      </div>
    </div>
  </div>
</div>

<!-- Page 4: Top Accessibility Issues -->
<div class="page">
  <div class="page-header">
    <h2>Top Accessibility Issues</h2>
    <p class="page-subtitle">Most impactful issues sorted by severity and frequency</p>
  </div>
  ${
    stats.topViolations.length > 0
      ? `
  <div class="chart-container" style="height:280px;">
    <canvas id="issuesChart" width="700" height="260"></canvas>
  </div>
  <div class="issues-table">
    <table>
      <thead>
        <tr>
          <th style="width:5%">#</th>
          <th style="width:12%">Severity</th>
          <th style="width:40%">Issue</th>
          <th style="width:13%">Instances</th>
          <th style="width:15%">Pages Affected</th>
          <th style="width:15%">Avg / Page</th>
        </tr>
      </thead>
      <tbody>
        ${stats.topViolations
          .map(
            (v, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><span class="severity-badge severity-${v.severity}">${v.severity}</span></td>
          <td class="issue-name">${this.escapeHtml(v.violationType)}</td>
          <td>${v.totalInstances}</td>
          <td>${v.pageUrls.length}</td>
          <td>${v.pageUrls.length > 0 ? (v.totalInstances / v.pageUrls.length).toFixed(1) : "—"}</td>
        </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  </div>
  `
      : '<p class="no-data">No accessibility issues found.</p>'
  }
</div>

<!-- Page 5+: Performance Overview (chunked) -->
${
  stats.lighthousePages.length > 0
    ? (() => {
        const ROWS_PER_PAGE = 25;
        const totalChunks = Math.ceil(
          stats.lighthousePages.length / ROWS_PER_PAGE
        );
        let perfPages = "";
        for (let chunk = 0; chunk < totalChunks; chunk++) {
          const chunkPages = stats.lighthousePages.slice(
            chunk * ROWS_PER_PAGE,
            (chunk + 1) * ROWS_PER_PAGE
          );
          const canvasHeight = chunkPages.length * 30 + 80;
          perfPages += `
<div class="page">
  <div class="page-header">
    <h2>Performance Overview${chunk > 0 ? " (continued)" : ""}</h2>
    ${chunk === 0 ? '<p class="page-subtitle">Lighthouse scores for all fully-audited pages</p>' : ""}
  </div>
  <div class="chart-container" style="height:${canvasHeight}px;">
    <canvas id="perfChart${chunk}" width="700" height="${canvasHeight - 20}"></canvas>
  </div>
</div>`;
        }
        return perfPages;
      })()
    : ""
}

<!-- Page 6: Page Health Matrix -->
<div class="page">
  <div class="page-header">
    <h2>Page Health Matrix</h2>
    <p class="page-subtitle">Color-coded overview of all audited pages</p>
  </div>
  <div class="heatmap-legend">
    <span class="heatmap-chip" style="background:#10B981">90-100</span>
    <span class="heatmap-chip" style="background:#F59E0B;color:#000">70-89</span>
    <span class="heatmap-chip" style="background:#EF4444">50-69</span>
    <span class="heatmap-chip" style="background:#991B1B">&lt;50</span>
    <span class="heatmap-chip" style="background:#374151">N/A</span>
  </div>
  ${this.buildPageHealthTable(data, hasDesktop, hasMobile)}
</div>

<!-- Broken Links (flow section) -->
<div class="flow-section">
  <div class="page-header">
    <h2>Broken Links Summary</h2>
  </div>
  ${this.buildBrokenLinksSection(data)}
</div>

<!-- Pages with Errors (flow section, only if any) -->
${
  data.failedPages && data.failedPages.length > 0
    ? `
<div class="flow-section">
  <div class="page-header">
    <h2>Pages with Errors</h2>
    <p class="page-subtitle">${data.failedPages.length} page${data.failedPages.length !== 1 ? "s" : ""} could not be audited after retry — results may be incomplete</p>
  </div>
  ${this.buildFailedPagesSection(data.failedPages)}
</div>
`
    : ""
}

<!-- Recommendations (flow section) -->
<div class="flow-section">
  <div class="page-header">
    <h2>Recommendations</h2>
    <p class="page-subtitle">Prioritized action items based on audit findings</p>
  </div>
  ${this.buildRecommendations(data, stats)}
  <div class="report-footer">
    <p>Generated on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
  </div>
</div>

<script>
${chartJsScript}
</script>
<script>
(function() {
  if (typeof Chart === 'undefined') return;

  Chart.defaults.animation = false;
  Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, sans-serif";

  const scoreColor = (score) => {
    if (score >= 90) return '#10B981';
    if (score >= 70) return '#F59E0B';
    if (score >= 50) return '#EF4444';
    return '#991B1B';
  };

  // --- Gauge Charts ---
  function createGauge(id, score, label) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const color = scoreColor(score);
    new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [score, 100 - score],
          backgroundColor: [color, '#E5E7EB'],
          borderWidth: 0
        }]
      },
      options: {
        cutout: '75%',
        responsive: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        }
      },
      plugins: [{
        id: 'centerText',
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          ctx.save();
          ctx.font = 'bold 36px Inter, sans-serif';
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(score + '%', width / 2, height / 2);
          ctx.restore();
        }
      }]
    });
  }

  createGauge('gaugePerf', ${stats.avgPerf}, 'Performance');
  createGauge('gaugeA11y', ${stats.avgA11y}, 'Accessibility');
  createGauge('gaugeSeo', ${stats.avgSeo}, 'SEO');
  createGauge('gaugeBp', ${stats.avgBp}, 'Best Practices');

  // --- Slide Summary mini gauges ---
  function makeMiniGauge(id, score) {
    const el = document.getElementById(id);
    if (!el) return;
    const color = scoreColor(score);
    new Chart(el, {
      type: 'doughnut',
      data: { datasets: [{ data: [score, 100 - score], backgroundColor: [color, '#E5E7EB'], borderWidth: 0 }] },
      options: { cutout: '70%', responsive: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      plugins: [{
        id: 'miniCt',
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          ctx.save();
          ctx.font = 'bold 16px Inter, sans-serif';
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(score + '%', width / 2, height / 2);
          ctx.restore();
        }
      }]
    });
  }
  makeMiniGauge('ss-perf', ${stats.avgPerf});
  makeMiniGauge('ss-a11y', ${stats.avgA11y});
  makeMiniGauge('ss-seo',  ${stats.avgSeo});
  makeMiniGauge('ss-bp',   ${stats.avgBp});

  ${
    hasDesktop && hasMobile
      ? `
  // --- Radar Chart ---
  const radarCanvas = document.getElementById('radarChart');
  if (radarCanvas) {
    new Chart(radarCanvas, {
      type: 'radar',
      data: {
        labels: ['Performance', 'Accessibility', 'SEO', 'Best Practices'],
        datasets: [
          {
            label: 'Desktop',
            data: [${stats.desktopPerf}, ${stats.desktopA11y}, ${stats.desktopSeo}, ${stats.desktopBp}],
            borderColor: '#3B82F6',
            backgroundColor: 'rgba(59, 130, 246, 0.15)',
            pointBackgroundColor: '#3B82F6',
            borderWidth: 2,
            pointRadius: 4
          },
          {
            label: 'Mobile',
            data: [${stats.mobilePerf}, ${stats.mobileA11y}, ${stats.mobileSeo}, ${stats.mobileBp}],
            borderColor: '#F97316',
            backgroundColor: 'rgba(249, 115, 22, 0.15)',
            pointBackgroundColor: '#F97316',
            borderWidth: 2,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: false,
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            ticks: { stepSize: 20, font: { size: 10 } },
            pointLabels: { font: { size: 12, weight: 'bold' } },
            grid: { color: '#E5E7EB' }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 12 }, padding: 20, usePointStyle: true, pointStyle: 'circle' }
          }
        }
      }
    });
  }
  `
      : ""
  }

  // --- Coverage Donut ---
  const coverageCanvas = document.getElementById('coverageChart');
  if (coverageCanvas) {
    new Chart(coverageCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Full Audit', 'Accessibility Only'],
        datasets: [{
          data: [${stats.fullAudits}, ${stats.axeOnlyAudits}],
          backgroundColor: ['#3B82F6', '#93C5FD'],
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: false,
        cutout: '55%',
        plugins: {
          legend: { display: false }
        }
      },
      plugins: [{
        id: 'centerTotal',
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          ctx.save();
          ctx.font = 'bold 28px Inter, sans-serif';
          ctx.fillStyle = '#1F2937';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('${stats.totalPages}', width / 2, height / 2 - 8);
          ctx.font = '12px Inter, sans-serif';
          ctx.fillStyle = '#6B7280';
          ctx.fillText('pages', width / 2, height / 2 + 14);
          ctx.restore();
        }
      }]
    });
  }

  // --- Severity Pie ---
  const severityCanvas = document.getElementById('severityChart');
  if (severityCanvas) {
    const sevData = [${stats.severityCounts.critical}, ${stats.severityCounts.serious}, ${stats.severityCounts.moderate}, ${stats.severityCounts.minor}];
    const hasData = sevData.some(d => d > 0);
    new Chart(severityCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Critical', 'Serious', 'Moderate', 'Minor'],
        datasets: [{
          data: hasData ? sevData : [1],
          backgroundColor: hasData ? ['#DC2626', '#F59E0B', '#3B82F6', '#9CA3AF'] : ['#E5E7EB'],
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: false,
        cutout: '55%',
        plugins: {
          legend: { display: false }
        }
      },
      plugins: [{
        id: 'centerSeverity',
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          const total = ${stats.severityCounts.critical + stats.severityCounts.serious + stats.severityCounts.moderate + stats.severityCounts.minor};
          ctx.save();
          ctx.font = 'bold 28px Inter, sans-serif';
          ctx.fillStyle = total > 0 ? '#DC2626' : '#10B981';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(total.toString(), width / 2, height / 2 - 8);
          ctx.font = '12px Inter, sans-serif';
          ctx.fillStyle = '#6B7280';
          ctx.fillText('issues', width / 2, height / 2 + 14);
          ctx.restore();
        }
      }]
    });
  }

  // --- Top Issues Bar Chart ---
  ${
    stats.topViolations.length > 0
      ? `
  const issuesCanvas = document.getElementById('issuesChart');
  if (issuesCanvas) {
    const issueLabels = ${JSON.stringify(stats.topViolations.map((v) => (v.violationType.length > 40 ? v.violationType.slice(0, 37) + "..." : v.violationType)))};
    const issueCounts = ${JSON.stringify(stats.topViolations.map((v) => v.totalInstances))};
    const issueColors = ${JSON.stringify(
      stats.topViolations.map(
        (v) =>
          ({
            critical: "#DC2626",
            serious: "#F59E0B",
            moderate: "#3B82F6",
            minor: "#9CA3AF",
          })[v.severity]
      )
    )};
    new Chart(issuesCanvas, {
      type: 'bar',
      data: {
        labels: issueLabels,
        datasets: [{
          data: issueCounts,
          backgroundColor: issueColors,
          borderRadius: 4,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { grid: { color: '#F3F4F6' }, ticks: { font: { size: 10 } } },
          y: { grid: { display: false }, ticks: { font: { size: 10 }, crossAlign: 'far' } }
        }
      }
    });
  }
  `
      : ""
  }

  // --- Performance Bar Charts (chunked) ---
  ${
    stats.lighthousePages.length > 0
      ? (() => {
          const ROWS_PER_PAGE = 25;
          const totalChunks = Math.ceil(
            stats.lighthousePages.length / ROWS_PER_PAGE
          );
          let chartCode = "";
          for (let chunk = 0; chunk < totalChunks; chunk++) {
            const chunkPages = stats.lighthousePages.slice(
              chunk * ROWS_PER_PAGE,
              (chunk + 1) * ROWS_PER_PAGE
            );
            const labels = chunkPages.map((p) => {
              const url = p.url.replace(/^https?:\/\/[^/]+/, "");
              const label = (url || "/") + " (" + p.viewport + ")";
              return label.length > 50 ? label.slice(0, 47) + "..." : label;
            });
            chartCode += `
  (function() {
    const canvas = document.getElementById('perfChart${chunk}');
    if (canvas) {
      new Chart(canvas, {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(labels)},
          datasets: [
            { label: 'Performance', data: ${JSON.stringify(chunkPages.map((p) => p.performanceScore))}, backgroundColor: '#3B82F6', borderRadius: 3, barPercentage: 0.7 },
            { label: 'Accessibility', data: ${JSON.stringify(chunkPages.map((p) => p.accessibilityScore))}, backgroundColor: '#8B5CF6', borderRadius: 3, barPercentage: 0.7 },
            { label: 'SEO', data: ${JSON.stringify(chunkPages.map((p) => p.seoScore))}, backgroundColor: '#10B981', borderRadius: 3, barPercentage: 0.7 },
            { label: 'Best Practices', data: ${JSON.stringify(chunkPages.map((p) => p.bestPracticesScore))}, backgroundColor: '#F59E0B', borderRadius: 3, barPercentage: 0.7 }
          ]
        },
        options: {
          indexAxis: 'y',
          responsive: false,
          plugins: {
            legend: { position: 'top', labels: { font: { size: 10 }, usePointStyle: true, pointStyle: 'rectRounded', padding: 15 } }
          },
          scales: {
            x: { max: 100, grid: { color: '#F3F4F6' }, ticks: { font: { size: 10 }, callback: v => v + '%' } },
            y: { grid: { display: false }, ticks: { font: { size: 9 }, crossAlign: 'far' } }
          }
        }
      });
    }
  })();`;
          }
          return chartCode;
        })()
      : ""
  }
})();
</script>
</body>
</html>`;
  }

  private calculateStats(data: PDFReportData) {
    const hasDesktop = data.desktop.pageReports.length > 0;
    const hasMobile = data.mobile.pageReports.length > 0;

    const desktopFull = data.desktop.pageReports.filter(
      (p) => p.auditTier === "full"
    );
    const mobileFull = data.mobile.pageReports.filter(
      (p) => p.auditTier === "full"
    );
    const desktopAxeOnly = data.desktop.pageReports.filter(
      (p) => p.auditTier !== "full"
    );
    const mobileAxeOnly = data.mobile.pageReports.filter(
      (p) => p.auditTier !== "full"
    );

    const avg = (reports: PageReport[], field: keyof PageReport): number => {
      const full = reports.filter((r) => r.auditTier === "full");
      if (full.length === 0) return 0;
      return Math.round(
        full.reduce((s, r) => s + (r[field] as number), 0) / full.length
      );
    };

    const desktopPerf = avg(data.desktop.pageReports, "performanceScore");
    const mobilePerf = avg(data.mobile.pageReports, "performanceScore");
    const desktopA11y = avg(data.desktop.pageReports, "accessibilityScore");
    const mobileA11y = avg(data.mobile.pageReports, "accessibilityScore");
    const desktopSeo = avg(data.desktop.pageReports, "seoScore");
    const mobileSeo = avg(data.mobile.pageReports, "seoScore");
    const desktopBp = avg(data.desktop.pageReports, "bestPracticesScore");
    const mobileBp = avg(data.mobile.pageReports, "bestPracticesScore");

    // Combined averages
    const allFull = [...desktopFull, ...mobileFull];
    const avgAll = (field: keyof PageReport) => {
      if (allFull.length === 0) return 0;
      return Math.round(
        allFull.reduce((s, r) => s + (r[field] as number), 0) / allFull.length
      );
    };

    // Violations
    const allViolationsMap = new Map<string, ViolationDetail>();
    [...data.desktop.violations, ...data.mobile.violations].forEach((v) => {
      const key = v.violationType;
      if (!allViolationsMap.has(key)) {
        allViolationsMap.set(key, { ...v, pageUrls: [], totalInstances: 0 });
      }
      const existing = allViolationsMap.get(key)!;
      existing.totalInstances += v.totalInstances;
      existing.pageUrls = [...new Set([...existing.pageUrls, ...v.pageUrls])];
    });

    const sortedViolations = Array.from(allViolationsMap.values())
      .sort((a, b) => {
        const order = {
          critical: 0,
          serious: 1,
          moderate: 2,
          minor: 3,
        } as Record<string, number>;
        const diff = (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
        return diff !== 0 ? diff : b.totalInstances - a.totalInstances;
      })
      .slice(0, 10);

    // Severity counts
    const allViolations = Array.from(allViolationsMap.values());
    const severityCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    allViolations.forEach((v) => {
      severityCounts[v.severity] += v.totalInstances;
    });

    // Lighthouse pages for bar chart
    const lighthousePages = [
      ...desktopFull.map((p) => ({ ...p, viewport: "desktop" as const })),
      ...mobileFull.map((p) => ({ ...p, viewport: "mobile" as const })),
    ].sort((a, b) => a.performanceScore - b.performanceScore);

    return {
      totalPages: Math.max(
        data.desktop.pageReports.length,
        data.mobile.pageReports.length
      ),
      fullAudits: Math.max(desktopFull.length, mobileFull.length),
      axeOnlyAudits: Math.max(desktopAxeOnly.length, mobileAxeOnly.length),
      totalCritical: severityCounts.critical,
      totalBrokenLinks:
        data.desktop.brokenLinks.length + data.mobile.brokenLinks.length,
      desktopPerf,
      mobilePerf,
      desktopA11y,
      mobileA11y,
      desktopSeo,
      mobileSeo,
      desktopBp,
      mobileBp,
      avgPerf: avgAll("performanceScore"),
      avgA11y: avgAll("accessibilityScore"),
      avgSeo: avgAll("seoScore"),
      avgBp: avgAll("bestPracticesScore"),
      topViolations: sortedViolations,
      severityCounts,
      lighthousePages,
      hasDesktop,
      hasMobile,
    };
  }

  private buildPageHealthTable(
    data: PDFReportData,
    hasDesktop: boolean,
    hasMobile: boolean
  ): string {
    // Merge desktop and mobile reports by URL
    const urlMap = new Map<
      string,
      { desktop?: PageReport; mobile?: PageReport }
    >();

    data.desktop.pageReports.forEach((p) => {
      if (!urlMap.has(p.url)) urlMap.set(p.url, {});
      urlMap.get(p.url)!.desktop = p;
    });
    data.mobile.pageReports.forEach((p) => {
      if (!urlMap.has(p.url)) urlMap.set(p.url, {});
      urlMap.get(p.url)!.mobile = p;
    });

    const entries = Array.from(urlMap.entries()).slice(0, 30); // Cap at 30 for readability

    if (entries.length === 0)
      return '<p class="no-data">No page data available.</p>';

    const scoreCell = (score: number | undefined, hasTier: boolean) => {
      if (!hasTier) return '<td class="score-cell na">--</td>';
      const s = score ?? 0;
      const cls =
        s >= 90 ? "good" : s >= 70 ? "ok" : s >= 50 ? "poor" : "critical";
      return `<td class="score-cell ${cls}">${s}</td>`;
    };

    const issueCell = (report?: PageReport) => {
      if (!report) return '<td class="score-cell na">--</td>';
      const total =
        report.criticalIssues +
        report.seriousIssues +
        report.moderateIssues +
        report.minorIssues;
      if (total === 0) return '<td class="score-cell good">0</td>';
      const cls =
        report.criticalIssues > 0
          ? "critical"
          : report.seriousIssues > 0
            ? "poor"
            : "ok";
      return `<td class="score-cell ${cls}">${total}</td>`;
    };

    let headers = '<th class="url-col">Page</th>';
    if (hasDesktop)
      headers +=
        "<th>D:Perf</th><th>D:A11y</th><th>D:SEO</th><th>D:BP</th><th>D:Issues</th>";
    if (hasMobile)
      headers +=
        "<th>M:Perf</th><th>M:A11y</th><th>M:SEO</th><th>M:BP</th><th>M:Issues</th>";

    let rows = "";
    entries.forEach(([url, reports]) => {
      const shortUrl = url.replace(/^https?:\/\/[^/]+/, "") || "/";
      const displayUrl =
        shortUrl.length > 45 ? shortUrl.slice(0, 42) + "..." : shortUrl;
      rows += `<tr><td class="url-cell" title="${this.escapeHtml(url)}">${this.escapeHtml(displayUrl)}</td>`;
      if (hasDesktop) {
        const d = reports.desktop;
        const dFull = d?.auditTier === "full";
        rows += scoreCell(d?.performanceScore, dFull);
        rows += scoreCell(d?.accessibilityScore, dFull);
        rows += scoreCell(d?.seoScore, dFull);
        rows += scoreCell(d?.bestPracticesScore, dFull);
        rows += issueCell(d);
      }
      if (hasMobile) {
        const m = reports.mobile;
        const mFull = m?.auditTier === "full";
        rows += scoreCell(m?.performanceScore, mFull);
        rows += scoreCell(m?.accessibilityScore, mFull);
        rows += scoreCell(m?.seoScore, mFull);
        rows += scoreCell(m?.bestPracticesScore, mFull);
        rows += issueCell(m);
      }
      rows += "</tr>";
    });

    if (urlMap.size > 30) {
      const colSpan = 1 + (hasDesktop ? 5 : 0) + (hasMobile ? 5 : 0);
      rows += `<tr><td colspan="${colSpan}" class="more-rows">... and ${urlMap.size - 30} more pages (see CSV for full data)</td></tr>`;
    }

    return `
    <div class="heatmap-table-wrapper">
      <table class="heatmap-table">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private buildSlideSummaryPage(
    data: PDFReportData,
    stats: ReturnType<PDFReportGenerator["calculateStats"]>
  ): string {
    const { hasDesktop, hasMobile } = stats;
    const date = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const viewportLabel =
      hasDesktop && hasMobile
        ? "Desktop &amp; Mobile"
        : hasDesktop
          ? "Desktop Only"
          : "Mobile Only";
    const top3 = stats.topViolations.slice(0, 3);
    const totalIssues =
      stats.severityCounts.critical +
      stats.severityCounts.serious +
      stats.severityCounts.moderate +
      stats.severityCounts.minor;

    const scoreDetail = (d: number, m: number): string => {
      const sc = (n: number) => n >= 90 ? '#10B981' : n >= 50 ? '#F59E0B' : '#EF4444';
      if (hasDesktop && hasMobile) return `<span style="color:${sc(d)}">D:${d}%</span> &nbsp;<span style="color:${sc(m)}">M:${m}%</span>`;
      if (hasDesktop) return `<span style="color:${sc(d)}">${d}%</span>`;
      return `<span style="color:${sc(m)}">${m}%</span>`;
    };

    // Build top 3 recommendations inline
    const recs: { priority: string; title: string; detail: string }[] = [];
    if (stats.severityCounts.critical > 0) {
      recs.push({
        priority: "critical",
        title: "Fix Critical Accessibility Issues",
        detail: `${stats.severityCounts.critical} critical violations found. These block users with disabilities and may carry legal risk.`,
      });
    }
    if (stats.avgPerf < 50 && stats.avgPerf > 0) {
      recs.push({
        priority: "critical",
        title: "Improve Page Performance",
        detail: `Average performance score is ${stats.avgPerf}%. Optimize images, reduce JavaScript, and leverage caching.`,
      });
    } else if (stats.avgPerf < 80 && stats.avgPerf > 0) {
      recs.push({
        priority: "high",
        title: "Optimize Page Performance",
        detail: `Average performance score is ${stats.avgPerf}%. Review Lighthouse recommendations for image and script optimization.`,
      });
    }
    if (stats.totalBrokenLinks > 0) {
      recs.push({
        priority: stats.totalBrokenLinks > 10 ? "high" : "medium",
        title: "Fix Broken Links",
        detail: `${stats.totalBrokenLinks} broken link${stats.totalBrokenLinks > 1 ? "s" : ""} found. These harm user experience and SEO.`,
      });
    }
    if (stats.avgA11y < 70 && stats.avgA11y > 0) {
      recs.push({
        priority: "high",
        title: "Improve Accessibility",
        detail: `Average accessibility score is ${stats.avgA11y}%. Focus on alt text, contrast, ARIA, and keyboard navigation.`,
      });
    }
    if (stats.avgSeo < 80 && stats.avgSeo > 0) {
      recs.push({
        priority: "medium",
        title: "Improve SEO",
        detail: `Average SEO score is ${stats.avgSeo}%. Check meta descriptions, heading hierarchy, and structured data.`,
      });
    }
    if (recs.length === 0) {
      recs.push({
        priority: "low",
        title: "Continue Monitoring",
        detail:
          "Site is performing well overall. Continue regular audits to catch regressions early.",
      });
    }
    const top3Recs = recs.slice(0, 3);

    return `
<div class="page ss-page">

  <!-- Header -->
  <div class="ss-header">
    <div class="ss-header-left">
      <div class="ss-domain">${this.escapeHtml(data.domain)}</div>
      <div class="ss-meta">${date} &nbsp;&middot;&nbsp; ${viewportLabel} &nbsp;&middot;&nbsp; ${stats.totalPages} pages audited</div>
    </div>
    <div class="ss-badge">Site Audit Summary</div>
  </div>

  <!-- Metrics strip -->
  <div class="ss-metrics">
    <div class="ss-metric">
      <span class="ss-metric-num">${stats.totalPages}</span>
      <span class="ss-metric-lbl">Pages Audited</span>
    </div>
    <div class="ss-metric">
      <span class="ss-metric-num">${stats.fullAudits}</span>
      <span class="ss-metric-lbl">Full Audits</span>
    </div>
    <div class="ss-metric ${stats.severityCounts.critical > 0 ? "ss-bad" : "ss-good"}">
      <span class="ss-metric-num">${stats.severityCounts.critical}</span>
      <span class="ss-metric-lbl">Critical Issues</span>
    </div>
    <div class="ss-metric ${stats.totalBrokenLinks > 0 ? "ss-warn" : "ss-good"}">
      <span class="ss-metric-num">${stats.totalBrokenLinks}</span>
      <span class="ss-metric-lbl">Broken Links</span>
    </div>
    <div class="ss-metric">
      <span class="ss-metric-num">${totalIssues}</span>
      <span class="ss-metric-lbl">Total A11y Issues</span>
    </div>
  </div>

  <!-- Main body: two columns -->
  <div class="ss-body">

    <!-- Left col: gauges + severity -->
    <div class="ss-left">
      <div class="ss-section-title">Lighthouse Scores${stats.fullAudits > 0 ? ` (avg. ${stats.fullAudits} page${stats.fullAudits !== 1 ? "s" : ""})` : ""}</div>
      <div class="ss-gauges">
        <div class="ss-gauge-wrap">
          <canvas id="ss-perf" width="72" height="72"></canvas>
          <div class="ss-gauge-lbl">Performance</div>
          <div class="ss-gauge-detail">${scoreDetail(stats.desktopPerf, stats.mobilePerf)}</div>
        </div>
        <div class="ss-gauge-wrap">
          <canvas id="ss-a11y" width="72" height="72"></canvas>
          <div class="ss-gauge-lbl">Accessibility</div>
          <div class="ss-gauge-detail">${scoreDetail(stats.desktopA11y, stats.mobileA11y)}</div>
        </div>
        <div class="ss-gauge-wrap">
          <canvas id="ss-seo" width="72" height="72"></canvas>
          <div class="ss-gauge-lbl">SEO</div>
          <div class="ss-gauge-detail">${scoreDetail(stats.desktopSeo, stats.mobileSeo)}</div>
        </div>
        <div class="ss-gauge-wrap">
          <canvas id="ss-bp" width="72" height="72"></canvas>
          <div class="ss-gauge-lbl">Best Practices</div>
          <div class="ss-gauge-detail">${scoreDetail(stats.desktopBp, stats.mobileBp)}</div>
        </div>
      </div>

      <div class="ss-section-title" style="margin-top:14px">Accessibility Issue Severity</div>
      <div class="ss-sev-row">
        <div class="ss-sev-tile ss-sev-critical">
          <span class="ss-sev-num">${stats.severityCounts.critical}</span>
          <span class="ss-sev-lbl">Critical</span>
        </div>
        <div class="ss-sev-tile ss-sev-serious">
          <span class="ss-sev-num">${stats.severityCounts.serious}</span>
          <span class="ss-sev-lbl">Serious</span>
        </div>
        <div class="ss-sev-tile ss-sev-moderate">
          <span class="ss-sev-num">${stats.severityCounts.moderate}</span>
          <span class="ss-sev-lbl">Moderate</span>
        </div>
        <div class="ss-sev-tile ss-sev-minor">
          <span class="ss-sev-num">${stats.severityCounts.minor}</span>
          <span class="ss-sev-lbl">Minor</span>
        </div>
      </div>
    </div>

    <!-- Right col: top issues + recommendations -->
    <div class="ss-right">
      <div class="ss-section-title">Top Accessibility Issues</div>
      ${
        top3.length > 0
          ? `
      <table class="ss-issues-table">
        <thead>
          <tr><th style="width:14%">Severity</th><th>Issue</th><th style="width:14%;text-align:right">Pages</th></tr>
        </thead>
        <tbody>
          ${top3
            .map(
              (v) => `
          <tr>
            <td><span class="severity-badge severity-${v.severity}">${v.severity}</span></td>
            <td class="ss-issue-name">${this.escapeHtml(v.violationType.length > 52 ? v.violationType.slice(0, 49) + "..." : v.violationType)}</td>
            <td style="text-align:right;color:#6B7280">${v.pageUrls.length}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
      `
          : '<p style="font-size:10px;color:#10B981;font-weight:600">No accessibility issues found.</p>'
      }

      <div class="ss-section-title" style="margin-top:14px">Priority Recommendations</div>
      <div class="ss-recs">
        ${top3Recs
          .map(
            (rec, i) => `
        <div class="ss-rec">
          <div class="ss-rec-num">${i + 1}</div>
          <div class="ss-rec-body">
            <div class="ss-rec-header">
              <span class="rec-priority priority-${rec.priority}">${rec.priority}</span>
              <span class="ss-rec-title">${this.escapeHtml(rec.title)}</span>
            </div>
            <p class="ss-rec-detail">${this.escapeHtml(rec.detail)}</p>
          </div>
        </div>`
          )
          .join("")}
      </div>
    </div>
  </div>

  <div class="ss-footer">${date}</div>
</div>`;
  }

  private buildIssuesAtAGlance(
    data: PDFReportData,
    stats: ReturnType<PDFReportGenerator["calculateStats"]>
  ): string {
    const top3 = stats.topViolations.slice(0, 3);
    const allBrokenLinks = [
      ...data.desktop.brokenLinks,
      ...data.mobile.brokenLinks,
    ];

    if (top3.length === 0 && allBrokenLinks.length === 0) return "";

    // Most common broken link error type
    const errorTypes = allBrokenLinks.reduce(
      (acc, l) => {
        const key = l.statusCode
          ? `HTTP ${l.statusCode}`
          : l.errorMessage?.split(":")[0] || "Error";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    const topErrorType = Object.entries(errorTypes).sort(
      (a, b) => b[1] - a[1]
    )[0];

    return `
    <div class="glance-box">
      <div class="glance-title">Issues at a Glance</div>
      <div class="glance-grid">
        ${
          top3.length > 0
            ? `
        <div class="glance-col">
          <div class="glance-col-header">Top Accessibility Issues</div>
          <ol class="glance-list">
            ${top3
              .map(
                (v) => `
            <li>
              <span class="severity-badge severity-${v.severity}">${v.severity}</span>
              <span class="glance-issue-name">${this.escapeHtml(v.violationType.length > 50 ? v.violationType.slice(0, 47) + "..." : v.violationType)}</span>
              <span class="glance-issue-meta">${v.pageUrls.length} page${v.pageUrls.length !== 1 ? "s" : ""}</span>
            </li>`
              )
              .join("")}
          </ol>
        </div>
        `
            : ""
        }
        ${
          allBrokenLinks.length > 0
            ? `
        <div class="glance-col">
          <div class="glance-col-header">Broken Links</div>
          <div class="glance-stat-big">${allBrokenLinks.length}</div>
          <div class="glance-stat-label">broken link${allBrokenLinks.length !== 1 ? "s" : ""} found</div>
          ${topErrorType ? `<div class="glance-stat-sub">Most common: ${this.escapeHtml(topErrorType[0])} (${topErrorType[1]})</div>` : ""}
        </div>
        `
            : `
        <div class="glance-col">
          <div class="glance-col-header">Broken Links</div>
          <div class="glance-stat-big good-text">0</div>
          <div class="glance-stat-label">No broken links found</div>
        </div>
        `
        }
      </div>
    </div>`;
  }

  private buildFailedPagesSection(failedPages: FailedPageEntry[]): string {
    return `
    <table class="failed-pages-table">
      <thead>
        <tr>
          <th style="width:50%">Page URL</th>
          <th style="width:12%">Viewport</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${failedPages
          .map(
            (p) => `
        <tr>
          <td class="failed-url">${this.escapeHtml(p.url)}</td>
          <td>${this.escapeHtml(p.viewport)}</td>
          <td class="failed-error">${this.escapeHtml(p.error)}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
  }

  private buildBrokenLinksSection(data: PDFReportData): string {
    const allLinks = [...data.desktop.brokenLinks, ...data.mobile.brokenLinks];

    if (allLinks.length === 0) {
      return '<p class="no-data good-news">No broken links found across all audited pages.</p>';
    }

    const byType = allLinks.reduce(
      (acc, link) => {
        if (!acc[link.linkType]) acc[link.linkType] = [];
        acc[link.linkType].push(link);
        return acc;
      },
      {} as Record<string, BrokenLink[]>
    );

    let html = '<div class="broken-links-grid">';

    Object.entries(byType).forEach(([type, links]) => {
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      html += `
      <div class="broken-link-type">
        <div class="broken-link-header">
          <span class="broken-link-type-label">${typeLabel}</span>
          <span class="broken-link-count">${links.length}</span>
        </div>
        <ul class="broken-link-list">
          ${links
            .slice(0, 10)
            .map(
              (link) => `
            <li>
              <span class="broken-link-url">${this.escapeHtml(this.truncateUrl(link.linkUrl, 60))}</span>
              ${link.statusCode ? `<span class="broken-link-status">${link.statusCode}</span>` : ""}
            </li>
          `
            )
            .join("")}
          ${links.length > 10 ? `<li class="more-links">+${links.length - 10} more</li>` : ""}
        </ul>
      </div>`;
    });

    html += "</div>";
    return html;
  }

  private buildRecommendations(
    _data: PDFReportData,
    stats: ReturnType<PDFReportGenerator["calculateStats"]>
  ): string {
    const recs: {
      priority: "critical" | "high" | "medium" | "low";
      title: string;
      detail: string;
    }[] = [];

    if (stats.severityCounts.critical > 0) {
      recs.push({
        priority: "critical",
        title: "Fix Critical Accessibility Issues",
        detail: `${stats.severityCounts.critical} critical accessibility violations found. These prevent users with disabilities from accessing your content and may expose you to legal risk.`,
      });
    }

    if (stats.avgPerf < 50 && stats.avgPerf > 0) {
      recs.push({
        priority: "critical",
        title: "Improve Page Performance",
        detail: `Average performance score is ${stats.avgPerf}%. Optimize images, reduce JavaScript bundles, implement lazy loading, and leverage browser caching.`,
      });
    } else if (stats.avgPerf < 80 && stats.avgPerf > 0) {
      recs.push({
        priority: "high",
        title: "Optimize Page Performance",
        detail: `Average performance score is ${stats.avgPerf}%. Review Lighthouse recommendations for image optimization, render-blocking resources, and unused code.`,
      });
    }

    if (stats.avgA11y < 70 && stats.avgA11y > 0) {
      recs.push({
        priority: "high",
        title: "Improve Accessibility Scores",
        detail: `Average accessibility score is ${stats.avgA11y}%. Focus on alt text, color contrast ratios, ARIA attributes, and keyboard navigation.`,
      });
    }

    if (stats.totalBrokenLinks > 10) {
      recs.push({
        priority: "high",
        title: "Fix Broken Links",
        detail: `${stats.totalBrokenLinks} broken links found. These harm user experience and SEO rankings. Prioritize fixing internal page links and broken images.`,
      });
    } else if (stats.totalBrokenLinks > 0) {
      recs.push({
        priority: "medium",
        title: "Fix Broken Links",
        detail: `${stats.totalBrokenLinks} broken link${stats.totalBrokenLinks > 1 ? "s" : ""} found. Review and fix to maintain site integrity.`,
      });
    }

    if (
      stats.hasDesktop &&
      stats.hasMobile &&
      stats.mobilePerf > 0 &&
      stats.mobilePerf < stats.desktopPerf - 20
    ) {
      recs.push({
        priority: "high",
        title: "Address Mobile Performance Gap",
        detail: `Mobile performance (${stats.mobilePerf}%) is significantly lower than desktop (${stats.desktopPerf}%). Optimize for mobile-first: reduce payloads, optimize images for smaller screens, and minimize main-thread work.`,
      });
    }

    if (stats.avgSeo < 80 && stats.avgSeo > 0) {
      recs.push({
        priority: "medium",
        title: "Improve SEO",
        detail: `Average SEO score is ${stats.avgSeo}%. Check meta descriptions, heading hierarchy, canonical URLs, and structured data.`,
      });
    }

    if (stats.severityCounts.serious > 20) {
      recs.push({
        priority: "medium",
        title: "Address Serious Accessibility Issues",
        detail: `${stats.severityCounts.serious} serious accessibility violations found across the site. These significantly impact usability for assistive technology users.`,
      });
    }

    if (recs.length === 0) {
      recs.push({
        priority: "low",
        title: "Continue Monitoring",
        detail:
          "Site is performing well overall. Continue regular audits and address minor issues as they arise.",
      });
    }

    return `
    <div class="recommendations-list">
      ${recs
        .map(
          (rec, i) => `
      <div class="rec-card">
        <div class="rec-number">${i + 1}</div>
        <div class="rec-content">
          <div class="rec-header">
            <span class="rec-priority priority-${rec.priority}">${rec.priority}</span>
            <span class="rec-title">${this.escapeHtml(rec.title)}</span>
          </div>
          <p class="rec-detail">${this.escapeHtml(rec.detail)}</p>
        </div>
      </div>
      `
        )
        .join("")}
    </div>`;
  }

  private scoreLabel(score: number): string {
    if (score === 0) return "";
    if (score >= 90)
      return '<div class="gauge-score-label score-good">Good</div>';
    if (score >= 50)
      return '<div class="gauge-score-label score-needs-work">Needs Work</div>';
    return '<div class="gauge-score-label score-poor">Poor</div>';
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private truncateUrl(url: string, max: number = 50): string {
    if (url.length <= max) return url;
    return url.substring(0, max - 3) + "...";
  }

  private getCss(): string {
    return `
    @page {
      size: A4;
      margin: 0;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      color: #1F2937;
      background: white;
      font-size: 11px;
      line-height: 1.5;
    }

    .page {
      width: 210mm;
      min-height: 297mm;
      padding: 20mm 18mm;
      page-break-after: always;
      position: relative;
    }

    /* Cover Page */
    .cover-page {
      padding: 0;
      background: linear-gradient(135deg, #0F172A 0%, #1E293B 50%, #334155 100%);
      color: white;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    .cover-badge {
      display: inline-block;
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.4);
      border-radius: 20px;
      padding: 6px 20px;
      font-size: 12px;
      letter-spacing: 3px;
      font-weight: 600;
      color: #93C5FD;
      margin-bottom: 20px;
    }
    .cover-domain {
      font-size: 36px;
      font-weight: 800;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .cover-date {
      font-size: 14px;
      color: #94A3B8;
      margin-bottom: 50px;
    }
    .cover-stats {
      display: flex;
      gap: 16px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 18px 24px;
      min-width: 110px;
    }
    .stat-number {
      font-size: 28px;
      font-weight: 800;
      color: #93C5FD;
    }
    .stat-label {
      font-size: 10px;
      color: #94A3B8;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }
    .cover-viewports {
      font-size: 13px;
      color: #94A3B8;
      margin-bottom: 60px;
    }
    .cover-footer {
      position: absolute;
      bottom: 30px;
      font-size: 10px;
      color: #475569;
    }

    /* Page Headers */
    .page-header {
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid #E5E7EB;
    }
    .page-header h2 {
      font-size: 22px;
      font-weight: 800;
      color: #0F172A;
      letter-spacing: -0.3px;
    }
    .page-subtitle {
      font-size: 11px;
      color: #6B7280;
      margin-top: 4px;
    }

    /* Score Gauges */
    .score-gauges {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 24px;
      margin: 24px 0;
    }
    .gauge-container {
      width: 45%;
      text-align: center;
    }
    .gauge-label {
      font-size: 13px;
      font-weight: 700;
      margin-top: 8px;
      color: #374151;
    }
    .gauge-score-label {
      display: inline-block;
      margin-top: 4px;
      padding: 2px 10px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .score-good { background: #D1FAE5; color: #065F46; }
    .score-needs-work { background: #FEF3C7; color: #92400E; }
    .score-poor { background: #FEE2E2; color: #991B1B; }

    /* ── Slide Summary Page ─────────────────────────── */
    .ss-page {
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .ss-header {
      background: linear-gradient(135deg, #0F172A 0%, #1E3A5F 100%);
      color: white;
      padding: 16px 22px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .ss-domain { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
    .ss-meta { font-size: 9.5px; color: #94A3B8; margin-top: 3px; }
    .ss-badge {
      background: rgba(59,130,246,0.25);
      border: 1px solid rgba(59,130,246,0.5);
      border-radius: 14px;
      padding: 4px 14px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #93C5FD;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .ss-metrics {
      display: flex;
      border-bottom: 1px solid #E5E7EB;
      flex-shrink: 0;
    }
    .ss-metric {
      flex: 1;
      padding: 9px 0;
      text-align: center;
      border-right: 1px solid #E5E7EB;
    }
    .ss-metric:last-child { border-right: none; }
    .ss-metric-num {
      display: block;
      font-size: 24px;
      font-weight: 800;
      color: #0F172A;
      line-height: 1.1;
    }
    .ss-bad .ss-metric-num { color: #DC2626; }
    .ss-good .ss-metric-num { color: #10B981; }
    .ss-warn .ss-metric-num { color: #F59E0B; }
    .ss-metric-lbl {
      display: block;
      font-size: 8.5px;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      margin-top: 2px;
    }
    .ss-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .ss-left {
      width: 46%;
      padding: 14px 16px 14px 22px;
      border-right: 1px solid #E5E7EB;
      display: flex;
      flex-direction: column;
    }
    .ss-right {
      flex: 1;
      padding: 14px 22px 14px 16px;
      display: flex;
      flex-direction: column;
    }
    .ss-section-title {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #9CA3AF;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid #F3F4F6;
    }
    .ss-gauges {
      display: flex;
      justify-content: space-around;
      flex-wrap: nowrap;
    }
    .ss-gauge-wrap { text-align: center; }
    .ss-gauge-lbl { font-size: 9px; font-weight: 700; color: #374151; margin-top: 4px; }
    .ss-gauge-detail { font-size: 7.5px; color: #6B7280; margin-top: 1px; }
    .ss-sev-row { display: flex; gap: 6px; }
    .ss-sev-tile {
      flex: 1;
      border-radius: 8px;
      padding: 8px 4px;
      text-align: center;
    }
    .ss-sev-num { display: block; font-size: 22px; font-weight: 800; line-height: 1; }
    .ss-sev-lbl { display: block; font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 3px; }
    .ss-sev-critical { background:#FEE2E2; }
    .ss-sev-critical .ss-sev-num { color:#991B1B; }
    .ss-sev-critical .ss-sev-lbl { color:#B91C1C; }
    .ss-sev-serious  { background:#FEF3C7; }
    .ss-sev-serious  .ss-sev-num { color:#92400E; }
    .ss-sev-serious  .ss-sev-lbl { color:#B45309; }
    .ss-sev-moderate { background:#DBEAFE; }
    .ss-sev-moderate .ss-sev-num { color:#1E40AF; }
    .ss-sev-moderate .ss-sev-lbl { color:#1D4ED8; }
    .ss-sev-minor    { background:#F3F4F6; }
    .ss-sev-minor    .ss-sev-num { color:#374151; }
    .ss-sev-minor    .ss-sev-lbl { color:#4B5563; }
    .ss-issues-table { width:100%; border-collapse:collapse; font-size:9.5px; }
    .ss-issues-table th {
      background:#F8FAFC; border-bottom:2px solid #E5E7EB;
      padding:5px 4px; text-align:left; font-weight:700; color:#374151;
      font-size:8px; text-transform:uppercase; letter-spacing:0.5px;
    }
    .ss-issues-table td { padding:6px 4px; border-bottom:1px solid #F3F4F6; vertical-align:middle; }
    .ss-issues-table tr:last-child td { border-bottom:none; }
    .ss-issue-name { font-weight:500; color:#1F2937; }
    .ss-recs { display:flex; flex-direction:column; gap:8px; }
    .ss-rec { display:flex; gap:8px; align-items:flex-start; }
    .ss-rec-num {
      width:18px; height:18px; border-radius:50%;
      background:#1E293B; color:white;
      font-size:9px; font-weight:700;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0; margin-top:1px;
    }
    .ss-rec-body { flex:1; }
    .ss-rec-header { display:flex; align-items:center; gap:6px; margin-bottom:2px; }
    .ss-rec-title { font-size:10px; font-weight:700; color:#1F2937; }
    .ss-rec-detail { font-size:9px; color:#4B5563; line-height:1.4; }
    .ss-footer {
      padding:7px 22px;
      background:#F8FAFC;
      border-top:1px solid #E5E7EB;
      font-size:8px;
      color:#9CA3AF;
      flex-shrink:0;
    }

    /* Issues at a Glance */
    .glance-box {
      margin-top: 24px;
      border: 1px solid #E5E7EB;
      border-radius: 10px;
      overflow: hidden;
    }
    .glance-title {
      background: #F8FAFC;
      border-bottom: 1px solid #E5E7EB;
      padding: 10px 16px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #374151;
    }
    .glance-grid {
      display: flex;
      gap: 0;
    }
    .glance-col {
      flex: 1;
      padding: 14px 16px;
      border-right: 1px solid #E5E7EB;
    }
    .glance-col:last-child { border-right: none; }
    .glance-col-header {
      font-size: 10px;
      font-weight: 700;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 10px;
    }
    .glance-list {
      list-style: none;
      counter-reset: glance-counter;
      padding: 0;
      margin: 0;
    }
    .glance-list li {
      counter-increment: glance-counter;
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 8px;
      font-size: 10px;
    }
    .glance-issue-name { flex: 1; color: #1F2937; }
    .glance-issue-meta { color: #9CA3AF; white-space: nowrap; font-size: 9px; }
    .glance-stat-big {
      font-size: 36px;
      font-weight: 800;
      color: #DC2626;
      line-height: 1;
      margin-bottom: 4px;
    }
    .glance-stat-big.good-text { color: #10B981; }
    .glance-stat-label { font-size: 11px; color: #374151; margin-bottom: 6px; }
    .glance-stat-sub { font-size: 9.5px; color: #6B7280; }

    /* Failed pages table */
    .failed-pages-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
    }
    .failed-pages-table th {
      background: #FEF2F2;
      border-bottom: 2px solid #FECACA;
      padding: 8px 10px;
      text-align: left;
      font-weight: 700;
      color: #991B1B;
      font-size: 9px;
      text-transform: uppercase;
    }
    .failed-pages-table td {
      padding: 7px 10px;
      border-bottom: 1px solid #FEE2E2;
      vertical-align: top;
    }
    .failed-url { word-break: break-all; color: #1F2937; }
    .failed-error { color: #DC2626; font-size: 9.5px; }

    .gauge-detail {
      font-size: 9px;
      color: #6B7280;
      margin-top: 2px;
    }

    /* Section titles */
    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: #374151;
      margin-bottom: 12px;
    }
    .section-spacing { height: 20px; }

    /* Charts */
    .chart-container {
      display: flex;
      justify-content: center;
      margin: 12px 0;
    }
    .radar-container { margin-top: 0; }
    .chart-container-sm {
      display: flex;
      justify-content: center;
      margin: 8px 0;
    }

    /* Two column layout */
    .two-col {
      display: flex;
      gap: 24px;
    }
    .col {
      flex: 1;
      text-align: center;
    }

    /* Coverage legend */
    .coverage-legend {
      text-align: left;
      margin-top: 12px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #374151;
      margin-bottom: 4px;
    }
    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* Issues table */
    .issues-table {
      margin-top: 16px;
    }
    .issues-table table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
    }
    .issues-table th {
      background: #F8FAFC;
      border-bottom: 2px solid #E5E7EB;
      padding: 8px 6px;
      text-align: left;
      font-weight: 700;
      color: #374151;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .issues-table td {
      padding: 7px 6px;
      border-bottom: 1px solid #F3F4F6;
      vertical-align: middle;
    }
    .issues-table tr:hover { background: #F8FAFC; }
    .issue-name {
      font-weight: 500;
      color: #1F2937;
    }

    /* Severity badges */
    .severity-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .severity-critical { background: #FEE2E2; color: #991B1B; }
    .severity-serious { background: #FEF3C7; color: #92400E; }
    .severity-moderate { background: #DBEAFE; color: #1E40AF; }
    .severity-minor { background: #F3F4F6; color: #4B5563; }

    /* Heatmap table */
    .heatmap-legend {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .heatmap-chip {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
      color: white;
    }
    .heatmap-table-wrapper {
      overflow: hidden;
    }
    .heatmap-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9px;
    }
    .heatmap-table th {
      background: #F8FAFC;
      border-bottom: 2px solid #E5E7EB;
      padding: 6px 4px;
      text-align: center;
      font-weight: 700;
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #374151;
    }
    .heatmap-table .url-col {
      text-align: left;
      width: 35%;
    }
    .url-cell {
      text-align: left;
      padding: 5px 4px;
      font-family: 'SF Mono', 'Cascadia Code', monospace;
      font-size: 8px;
      color: #374151;
      border-bottom: 1px solid #F3F4F6;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }
    .score-cell {
      text-align: center;
      padding: 4px 2px;
      font-weight: 700;
      font-size: 9px;
      border-bottom: 1px solid #F3F4F6;
    }
    .score-cell.good { background: #D1FAE5; color: #065F46; }
    .score-cell.ok { background: #FEF3C7; color: #92400E; }
    .score-cell.poor { background: #FEE2E2; color: #991B1B; }
    .score-cell.critical { background: #991B1B; color: white; }
    .score-cell.na { background: #F9FAFB; color: #9CA3AF; }
    .more-rows {
      text-align: center;
      color: #6B7280;
      font-style: italic;
      padding: 8px;
    }

    /* Broken Links */
    .broken-links-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .broken-link-type {
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 8px;
      padding: 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .broken-link-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .broken-link-type-label {
      font-weight: 700;
      font-size: 12px;
      color: #374151;
    }
    .broken-link-count {
      background: #EF4444;
      color: white;
      border-radius: 12px;
      padding: 2px 10px;
      font-size: 10px;
      font-weight: 700;
    }
    .broken-link-list {
      list-style: none;
    }
    .broken-link-list li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      border-bottom: 1px solid #E5E7EB;
      font-size: 9px;
    }
    .broken-link-list li:last-child { border-bottom: none; }
    .broken-link-url {
      color: #374151;
      font-family: 'SF Mono', 'Cascadia Code', monospace;
      font-size: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }
    .broken-link-status {
      background: #FEE2E2;
      color: #991B1B;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 8px;
      font-weight: 600;
    }
    .more-links {
      color: #6B7280;
      font-style: italic;
    }

    /* Recommendations */
    .recommendations-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .rec-card {
      display: flex;
      gap: 14px;
      padding: 14px;
      background: #F9FAFB;
      border: 1px solid #E5E7EB;
      border-radius: 8px;
    }
    .rec-number {
      width: 28px;
      height: 28px;
      background: #1F2937;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 12px;
      flex-shrink: 0;
    }
    .rec-content { flex: 1; }
    .rec-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .rec-priority {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .priority-critical { background: #FEE2E2; color: #991B1B; }
    .priority-high { background: #FEF3C7; color: #92400E; }
    .priority-medium { background: #DBEAFE; color: #1E40AF; }
    .priority-low { background: #D1FAE5; color: #065F46; }
    .rec-title {
      font-weight: 700;
      font-size: 13px;
      color: #1F2937;
    }
    .rec-detail {
      font-size: 10px;
      color: #4B5563;
      line-height: 1.6;
    }

    /* Utilities */
    .no-data {
      text-align: center;
      color: #6B7280;
      padding: 40px;
      font-size: 14px;
    }
    .good-news { color: #065F46; }
    .report-footer {
      margin-top: auto;
      text-align: center;
      font-size: 9px;
      color: #9CA3AF;
      border-top: 1px solid #E5E7EB;
      padding-top: 12px;
    }

    /* Flow sections - no forced min-height or page breaks */
    .flow-section {
      width: 210mm;
      padding: 20mm 18mm;
      page-break-before: always;
    }
    `;
  }
}
