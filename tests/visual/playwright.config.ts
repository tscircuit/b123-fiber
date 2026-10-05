import { defineConfig } from '@playwright/test'
const chromiumPath = process.env.CHROMIUM_PATH
export default defineConfig({
  testDir: '.', testMatch: /(?:gallery|viewer)\.spec\.ts/, fullyParallel: false, workers: 1,
  updateSnapshots: 'none',
  timeout: 120_000, expect: { timeout: 20_000, toHaveScreenshot: { animations: 'disabled', threshold: 0, maxDiffPixels: 0 } },
  reporter: [['list'], ['json', { outputFile: '../../artifacts/visual/results.json' }], ['html', { outputFolder: '../../artifacts/visual/report', open: 'never' }]],
  outputDir: '../../artifacts/visual/failures', snapshotPathTemplate: process.env.B123_BROWSER_BASELINES === '1' ? '{testDir}/browser-baselines/{arg}{ext}' : '{testDir}/baselines/{arg}{ext}',
  use: { baseURL: process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:5173', viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1, headless: true,
    launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
})
