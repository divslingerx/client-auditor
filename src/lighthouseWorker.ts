/**
 * Lighthouse Worker - runs in a child process to isolate memory.
 *
 * Lighthouse accumulates ~200-500MB of traces, devtools logs, and artifacts
 * per run. In the main process this leads to OOM after ~30+ runs. By forking
 * a child process for each run, the OS reclaims all memory when the child exits.
 *
 * Communication: parent sends config via IPC, child sends back scores, then exits.
 */

import lighthouse from 'lighthouse';

interface WorkerMessage {
  url: string;
  port: number;
  viewport: 'desktop' | 'mobile';
  minimal?: boolean;
}

interface WorkerResult {
  success: boolean;
  scores?: {
    performance: number;
    accessibility: number;
    'best-practices': number;
    seo: number;
  };
  error?: string;
}

async function runLighthouse(msg: WorkerMessage): Promise<WorkerResult> {
  try {
    if (msg.minimal) {
      return await runMinimal(msg);
    }

    const runnerResult = await lighthouse(msg.url, {
      port: msg.port,
      maxWaitForLoad: 60000,
      gatherMode: false,
      disableStorageReset: false,
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      throttlingMethod: 'provided',
      formFactor: msg.viewport === 'mobile' ? 'mobile' : 'desktop',
      screenEmulation: {
        mobile: msg.viewport === 'mobile',
        width: msg.viewport === 'mobile' ? 393 : 1920,
        height: msg.viewport === 'mobile' ? 852 : 1080,
        deviceScaleFactor: msg.viewport === 'mobile' ? 2 : 1,
        disabled: false
      },
      emulatedUserAgent: msg.viewport === 'mobile'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15'
        : undefined,
      skipAudits: [
        'screenshot-thumbnails',
        'final-screenshot',
        'full-page-screenshot',
        'script-treemap-data',
        'uses-long-cache-ttl',
        'total-byte-weight',
        'offscreen-images',
        'uses-webp-images',
        'uses-optimized-images',
        'modern-image-formats',
        'uses-text-compression',
        'uses-responsive-images',
        'efficient-animated-content'
      ],
      onlyAudits: null,
      networkQuietThresholdMs: 1000,
      cpuQuietThresholdMs: 1000
    });

    if (!runnerResult || !runnerResult.lhr) {
      return { success: false, error: 'Lighthouse returned no results' };
    }

    return {
      success: true,
      scores: {
        performance: runnerResult.lhr.categories.performance.score || 0,
        accessibility: runnerResult.lhr.categories.accessibility.score || 0,
        'best-practices': runnerResult.lhr.categories['best-practices'].score || 0,
        seo: runnerResult.lhr.categories.seo.score || 0
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message?.slice(0, 200) || String(error) };
  }
}

async function runMinimal(msg: WorkerMessage): Promise<WorkerResult> {
  try {
    const runnerResult = await lighthouse(msg.url, {
      port: msg.port,
      maxWaitForLoad: 30000,
      onlyCategories: ['performance', 'accessibility'],
      throttlingMethod: 'provided',
      disableStorageReset: true,
      skipAudits: [
        'screenshot-thumbnails',
        'final-screenshot',
        'full-page-screenshot',
        'script-treemap-data',
        'uses-long-cache-ttl',
        'total-byte-weight',
        'offscreen-images',
        'uses-webp-images',
        'uses-optimized-images',
        'modern-image-formats',
        'uses-text-compression',
        'uses-responsive-images',
        'efficient-animated-content',
        'largest-contentful-paint-element',
        'layout-shift-elements',
        'long-tasks',
        'non-composited-animations',
        'unsized-images',
        'valid-source-maps',
        'preload-fonts',
        'network-rtt',
        'network-server-latency',
        'main-thread-tasks',
        'diagnostics',
        'metrics',
        'interactive',
        'speed-index',
        'total-blocking-time',
        'max-potential-fid',
        'cumulative-layout-shift',
        'errors-in-console',
        'server-response-time',
        'user-timings',
        'critical-request-chains',
        'redirects',
        'mainthread-work-breakdown',
        'bootup-time',
        'uses-rel-preload',
        'uses-rel-preconnect',
        'font-display',
        'third-party-summary',
        'third-party-facades',
        'lcp-lazy-loaded',
        'uses-passive-event-listeners',
        'no-document-write',
        'legacy-javascript',
        'inspector-issues',
        'no-unload-listeners'
      ]
    });

    if (!runnerResult?.lhr) {
      return { success: false, error: 'Minimal Lighthouse returned no results' };
    }

    return {
      success: true,
      scores: {
        performance: runnerResult.lhr.categories.performance?.score || 0,
        accessibility: runnerResult.lhr.categories.accessibility?.score || 0,
        'best-practices': 0,
        seo: 0
      }
    };
  } catch (error: any) {
    return { success: false, error: error.message?.slice(0, 200) || String(error) };
  }
}

// Listen for messages from parent process
process.on('message', async (msg: WorkerMessage) => {
  const result = await runLighthouse(msg);
  process.send!(result);
  // Exit cleanly — OS reclaims all Lighthouse memory
  process.exit(0);
});
