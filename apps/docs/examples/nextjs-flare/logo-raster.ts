import { logoPixelSize } from './settings';

const LOGO_SVG = `<svg width="514" height="624" viewBox="-48 -88 514 624" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#c)"><path d="M299.613 .5H367.707V353.534H299.613V.5Z" stroke="url(#a)" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="M68.9932 1L464.505 500.213C450.221 512.747 435.107 524.362 419.255 534.966L54.9629 74.459L54.0703 73.3311V347.458H.5V1H68.9932Z" stroke="url(#b)" stroke-width="2" vector-effect="non-scaling-stroke"/></g><defs><linearGradient id="a" x1="367.707" y1="151.917" x2="367.707" y2="353.534" gradientUnits="userSpaceOnUse"><stop stop-color="#EDEDED"/><stop offset=".3" stop-color="#EDEDED" stop-opacity="0"/></linearGradient><linearGradient id="b" x1="281.642" y1="308.647" x2="424.017" y2="486.349" gradientUnits="userSpaceOnUse"><stop stop-color="#EDEDED"/><stop offset="1" stop-color="#EDEDED" stop-opacity="0"/></linearGradient><clipPath id="c"><path fill="#fff" d="M0 0h466v536H0z"/></clipPath></defs></svg>`;

export async function rasterizeLogo(
  size: number,
  logoSize: number,
): Promise<HTMLCanvasElement> {
  const [width, height] = logoPixelSize(size, logoSize);
  const pad = 3;
  const canvas = document.createElement('canvas');
  canvas.width = width + pad * 2;
  canvas.height = height + pad * 2;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the logo raster canvas.');
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error('Could not decode the Next.js logo SVG.'));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LOGO_SVG)}`;
  await loaded;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, pad, pad, width, height);
  return canvas;
}
