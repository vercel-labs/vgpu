// Run in the preview page console. The returned base64 replaces runs in lettering.ts.
(async () => {
  await Promise.all([document.fonts.load('500 64px Geist'), document.fonts.load('400 24px "Geist Mono"')]);
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 1456;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = '500 64px Geist'; ctx.fillText('vgpu', 78, 132);
  ctx.font = '400 64px Geist'; ctx.fillText('Holographic', 78, 1170);
  ctx.fillStyle = '#999'; ctx.font = '400 30px Geist'; ctx.fillText('Light, computed.', 80, 1224);
  ctx.fillStyle = '#bbb'; ctx.font = '400 22px "Geist Mono"'; ctx.letterSpacing = '4px';
  ctx.fillText('EDITION 001', 80, 1360);
  ctx.textAlign = 'right'; ctx.fillText('WEBGPU', 944, 1360);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const runs = []; let value = 0; let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const next = Math.round(rgba[i] * rgba[i + 3] / 255);
    if (next !== value || count === 255) { if(count) runs.push(count, value); value = next; count = 0; }
    count++;
  }
  if (count) runs.push(count, value);
  return { width: canvas.width, height: canvas.height, runs: btoa(String.fromCharCode(...runs)) };
})()
