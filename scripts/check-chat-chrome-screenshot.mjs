#!/usr/bin/env node
/**
 * Rendered screenshot gate for the chat chrome/surface regression.
 *
 * Source-side CSS contracts catch gradients and borders, but WAWQAQ's
 * repeated failure mode was visual: the sidebar/content seam and the
 * lower surface radius looked wrong even after "correct" CSS edits.
 * This script inspects actual pixels from the canonical visual-smoke
 * capture:
 *
 *   npm --workspace @maka/desktop run screenshots:single -- sidebar-long-sessions --variant light-1280-motion
 *   npm --workspace @maka/desktop run screenshots:chat-chrome:check
 *
 * It intentionally avoids pixel-perfect image diffs. It only asserts
 * structural facts that should survive font/rendering drift:
 *   - the shell gutter is visibly distinct from the white content card
 *   - there is no dark one-pixel seam at the sidebar/content boundary
 *   - the bottom left/right rounded corners expose shell/shadow pixels
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_SCREENSHOT = join(
  REPO_ROOT,
  'apps',
  'desktop',
  'tests',
  'screenshots',
  'sidebar-long-sessions',
  'light-1280-motion.png',
);
const STYLES_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');
const RENDERER_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'main.tsx');

const EXPECTED_LOGICAL_WIDTH = 1280;
const EXPECTED_LOGICAL_HEIGHT = 820;
const MIN_SHELL_TO_CARD_DISTANCE = 3;
const MIN_CORNER_TO_CARD_DISTANCE = 3;
const MIN_SEAM_LUMINANCE = 242;

async function main() {
  const screenshotPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SCREENSHOT;
  if (!existsSync(screenshotPath)) {
    fail(
      `missing screenshot: ${rel(screenshotPath)}\n` +
        'Run: npm --workspace @maka/desktop run screenshots:single -- sidebar-long-sessions --variant light-1280-motion',
    );
  }

  const [css, rendererSource] = await Promise.all([
    readFile(STYLES_PATH, 'utf8'),
    readFile(RENDERER_PATH, 'utf8'),
  ]);
  const sidebarWidth = readTsNumberConst(rendererSource, 'SESSION_LIST_EXPANDED_DEFAULT_WIDTH');
  const panelBody = extractRuleBody(css, '.maka-panel-detail.maka-floating-panel');
  if (!panelBody) fail('missing .maka-panel-detail.maka-floating-panel rule');
  const surfaceMargin = readCssPxProperty(panelBody, 'margin');
  const surfaceRadius = readCssPxProperty(panelBody, 'border-radius');

  const image = await decodePng(screenshotPath);
  const scaleX = image.width / EXPECTED_LOGICAL_WIDTH;
  const scaleY = image.height / EXPECTED_LOGICAL_HEIGHT;
  if (Math.abs(scaleX - scaleY) > 0.02) {
    fail(`unexpected screenshot scale: ${image.width}x${image.height}`);
  }
  const scale = scaleX;

  const left = Math.round((sidebarWidth + surfaceMargin) * scale);
  const top = Math.round(surfaceMargin * scale);
  const right = Math.round((EXPECTED_LOGICAL_WIDTH - surfaceMargin) * scale) - 1;
  const bottom = Math.round((EXPECTED_LOGICAL_HEIGHT - surfaceMargin) * scale) - 1;
  const radius = Math.round(surfaceRadius * scale);

  const midY = Math.round(EXPECTED_LOGICAL_HEIGHT * 0.5 * scale);
  const shellGutter = sampleAverage(
    image,
    Math.round((sidebarWidth + surfaceMargin * 0.5) * scale),
    midY,
    2,
    28,
  );
  const cardInterior = sampleAverage(image, left + radius + Math.round(32 * scale), midY, 8, 28);
  const shellToCard = colorDistance(shellGutter.rgb, cardInterior.rgb);

  assertAtLeast(
    shellToCard,
    MIN_SHELL_TO_CARD_DISTANCE,
    `shell gutter must be visibly distinct from white content card (distance ${shellToCard.toFixed(2)})`,
  );

  const seam = sampleAverage(image, Math.round(sidebarWidth * scale), midY, 1, 220);
  assertAtLeast(
    seam.luminance,
    MIN_SEAM_LUMINANCE,
    `sidebar/content boundary must not contain a dark one-pixel seam (luminance ${seam.luminance.toFixed(2)})`,
  );

  const bottomCard = sampleAverage(
    image,
    left + radius + Math.round(36 * scale),
    bottom - radius - Math.round(12 * scale),
    8,
    8,
  );
  const bottomLeftCorner = sampleAverage(
    image,
    left + Math.round(3 * scale),
    bottom - Math.round(3 * scale),
    2,
    2,
  );
  const bottomRightCorner = sampleAverage(
    image,
    right - Math.round(3 * scale),
    bottom - Math.round(3 * scale),
    2,
    2,
  );
  const bottomGutter = sampleAverage(
    image,
    left + radius + Math.round(48 * scale),
    Math.round((EXPECTED_LOGICAL_HEIGHT - surfaceMargin * 0.45) * scale),
    8,
    2,
  );

  assertAtLeast(
    colorDistance(bottomLeftCorner.rgb, bottomCard.rgb),
    MIN_CORNER_TO_CARD_DISTANCE,
    'bottom-left radius must expose shell/shadow pixels, not collapse into an invisible white rectangle',
  );
  assertAtLeast(
    colorDistance(bottomRightCorner.rgb, bottomCard.rgb),
    MIN_CORNER_TO_CARD_DISTANCE,
    'bottom-right radius must expose shell/shadow pixels, not collapse into an invisible white rectangle',
  );
  assertAtLeast(
    colorDistance(bottomGutter.rgb, bottomCard.rgb),
    MIN_SHELL_TO_CARD_DISTANCE,
    'bottom gutter must stay visible under the content surface',
  );

  console.log(
    `[check-chat-chrome-screenshot] OK ${rel(screenshotPath)} ` +
      `scale=${scale.toFixed(2)} shell/card=${shellToCard.toFixed(2)} seam=${seam.luminance.toFixed(2)}`,
  );
}

function assertAtLeast(value, min, message) {
  if (value < min) fail(`${message}; expected >= ${min}`);
}

function fail(message) {
  console.error(`[check-chat-chrome-screenshot] ${message}`);
  process.exit(1);
}

function rel(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

function readTsNumberConst(source, name) {
  const match = source.match(
    new RegExp(`const\\s+${escapeRegExp(name)}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`),
  );
  if (!match) fail(`missing renderer numeric constant ${name}`);
  return Number(match[1]);
}

function readCssPxProperty(ruleBody, name) {
  const match = ruleBody
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(new RegExp(`${escapeRegExp(name)}:\\s*([0-9]+(?:\\.[0-9]+)?)px\\s*;`));
  if (!match) fail(`missing CSS property ${name}`);
  return Number(match[1]);
}

function extractRuleBody(css, selector) {
  const index = css.indexOf(selector);
  if (index === -1) return undefined;
  const open = css.indexOf('{', index);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function decodePng(path) {
  const buf = await readFile(path);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || buf.compare(magic, 0, 8, 0, 8) !== 0) fail(`not a PNG: ${rel(path)}`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    fail(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = raw[source++];
      if (filter === 1) value = (value + left) & 0xff;
      else if (filter === 2) value = (value + up) & 0xff;
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) value = (value + paeth(left, up, upperLeft)) & 0xff;
      else if (filter !== 0) fail(`unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = value;
    }
  }

  return { width, height, channels, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function sampleAverage(image, centerX, centerY, halfWidth, halfHeight) {
  const x0 = clamp(centerX - halfWidth, 0, image.width - 1);
  const x1 = clamp(centerX + halfWidth, 0, image.width - 1);
  const y0 = clamp(centerY - halfHeight, 0, image.height - 1);
  const y1 = clamp(centerY + halfHeight, 0, image.height - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const index = (y * image.width + x) * image.channels;
      r += image.pixels[index];
      g += image.pixels[index + 1];
      b += image.pixels[index + 2];
      count += 1;
    }
  }
  const rgb = [r / count, g / count, b / count];
  return { rgb, luminance: (rgb[0] + rgb[1] + rgb[2]) / 3 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

main().catch((error) => {
  console.error('[check-chat-chrome-screenshot] fatal:', error);
  process.exit(1);
});
