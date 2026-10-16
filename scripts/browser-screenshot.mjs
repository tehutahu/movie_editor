import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";

// Activate each evidence tab before capture. Retry only Chromium's transient
// capture error once; missing evidence and all other errors still fail the suite.
export async function captureEvidenceScreenshot(page, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.bringToFront();
    try {
      await page.screenshot({ path, fullPage: true, timeout: 15000 });
      return;
    } catch (error) {
      if (
        attempt !== 0 ||
        !String(error?.message).includes(
          "Protocol error (Page.captureScreenshot): Unable to capture screenshot",
        )
      ) {
        throw error;
      }
      console.warn(`Retrying Chromium evidence capture once: ${path}`);
      await delay(250);
    }
  }
}
