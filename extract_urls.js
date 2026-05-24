const { chromium } = require('playwright');

async function resolveFinalUrlByFollowingRedirects(requestContext, url) {
  try {
    const headResponse = await requestContext.fetch(url, {
      method: 'HEAD',
      maxRedirects: 10,
      timeout: 10000,
    });
    return headResponse.url();
  } catch {
    // Some servers reject HEAD. Fallback to a minimal GET using Range.
    const getResponse = await requestContext.fetch(url, {
      method: 'GET',
      maxRedirects: 10,
      timeout: 10000,
      headers: {
        Range: 'bytes=0-0',
      },
    });
    return getResponse.url();
  }
}

async function extractVideoUrl(postUrl) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let trafficDepositVidUrl = null;

  try {
    const isTrafficDepositVid = (url) => /(^|\.)trafficdeposit\.com\b/i.test(url) && /\.vid($|\?)/i.test(url);

    page.on('request', (req) => {
      const url = req.url();
      if (isTrafficDepositVid(url)) trafficDepositVidUrl = trafficDepositVidUrl || url;
    });

    page.on('response', (res) => {
      const url = res.url();
      if (isTrafficDepositVid(url)) trafficDepositVidUrl = trafficDepositVidUrl || url;
    });

    await page.route('**/*', async (route) => {
      const url = route.request().url();

      if (isTrafficDepositVid(url)) {
        trafficDepositVidUrl = trafficDepositVidUrl || url;
        await route.abort();
        return;
      }

      await route.continue();
    });

    await page.goto(postUrl, { waitUntil: 'domcontentloaded' });

    // Wait for video element or player to load
    await page.waitForSelector('video, .player, [data-src]', { timeout: 10000 });

    // Trigger the player to start loading the media URL (some pages won't request the .vid until play).
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        try {
          v.muted = true;
          v.playsInline = true;
          const p = v.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }

      const clickable = document.querySelector('video, .player, .vjs-big-play-button, button');
      if (clickable && typeof clickable.click === 'function') {
        try { clickable.click(); } catch {}
      }
    });

    const start = Date.now();
    while (!trafficDepositVidUrl && Date.now() - start < 8000) {
      await page.waitForTimeout(200);
    }

    // Try to find the video source URL
    const videoSrc = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        return video.src || video.querySelector('source')?.src;
      }

      // If no direct video, look for data-src or similar attributes
      const player = document.querySelector('.player, .video-player');
      if (player) {
        return player.getAttribute('data-src') || player.getAttribute('data-video');
      }

      // Look for any element with a .vid URL
      const links = Array.from(document.querySelectorAll('a[href*=".vid"], source[src*=".vid"]'));
      if (links.length > 0) {
        return links[0].href || links[0].src;
      }

      return null;
    });

    if (!videoSrc) return null;

    try {
      const response = await page.request.fetch(videoSrc, {
        method: 'GET',
        maxRedirects: 0,
        timeout: 10000,
      });

      const status = response.status();
      const headers = response.headers();
      const location = headers.location;

      let method1Url = null;
      if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && location) {
        method1Url = location.startsWith('//') ? `https:${location}` : location;
      }

      const method2Url = trafficDepositVidUrl;

      let method3Url = null;
      try {
        method3Url = await resolveFinalUrlByFollowingRedirects(page.request, videoSrc);
      } catch (e) {
        console.error(`Error following redirects for ${videoSrc}:`, e?.message || String(e));
      }

      const maybeUrl = response.url();
      const finalUrl = method1Url || method2Url || method3Url || maybeUrl;
      return {
        finalUrl,
        method1Url,
        method2Url,
        method3Url,
        videoSrc,
      };
    } catch (redirectError) {
      console.error(`Error following redirect for ${videoSrc}:`, redirectError.message);

      let method3Url = null;
      try {
        method3Url = await resolveFinalUrlByFollowingRedirects(page.request, videoSrc);
      } catch {}

      return {
        finalUrl: trafficDepositVidUrl || method3Url || videoSrc,
        method1Url: null,
        method2Url: trafficDepositVidUrl,
        method3Url,
        videoSrc,
      };
    }
  } catch (error) {
    console.error(`Error extracting URL from ${postUrl}:`, error.message);
    return null;
  } finally {
    await browser.close();
  }
}

async function main() {
  const postUrl = process.argv[2];
  if (!postUrl) {
    console.error('Usage: node extract_urls.js "https://sxyprn.net/post/<id>"');
    process.exit(2);
  }

  const result = await extractVideoUrl(postUrl);
  if (!result || (!result.method1Url && !result.method2Url && !result.method3Url)) {
    console.error('No video URL found.');
    process.exit(1);
  }

  process.stdout.write(`Method 1: ${result.method1Url || ''}\n`);
  process.stdout.write(`Method 2: ${result.method2Url || ''}\n`);
  process.stdout.write(`Method 3: ${result.method3Url || ''}\n`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
