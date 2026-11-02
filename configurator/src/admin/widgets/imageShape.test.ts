import { describe, expect, it } from 'vitest';
import { shapeError } from './imageShape';

const footerLogo = { aspectRatio: 4, aspectTolerance: 0.02, minWidth: 320, minHeight: 80 };

describe('shapeError (sidebar footer logo, 4:1)', () => {
  it('accepts an exact 4:1 image', () => {
    expect(shapeError(800, 200, footerLogo)).toBeNull();
    expect(shapeError(320, 80, footerLogo)).toBeNull();
  });

  it('accepts an image within ±2% of 4:1', () => {
    // 812 / 200 = 4.06 → 1.5% off
    expect(shapeError(812, 200, footerLogo)).toBeNull();
  });

  it('refuses a wrong shape and says what it is', () => {
    expect(shapeError(600, 400, footerLogo)).toBe('Image must be 4:1. This one is 600 × 400 px (1.5:1).');
    // 3:1 — a common banner shape, still refused
    expect(shapeError(900, 300, footerLogo)).toMatch(/must be 4:1/);
  });

  it('refuses a 4:1 image below the minimum size', () => {
    expect(shapeError(200, 50, footerLogo)).toBe('Image is too small: 200 × 50 px. Use at least 320 × 80 px.');
  });

  it('refuses a zero-height image rather than dividing by zero', () => {
    expect(shapeError(800, 0, footerLogo)).toMatch(/must be 4:1/);
  });
});
